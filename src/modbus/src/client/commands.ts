/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Consumes commandsQueue inserts for this connection and dispatches them as
// Modbus writes (FC5/6/15/16/22), then acknowledges the command document.

import type { ChangeStream, Collection } from 'mongodb'
import Log from '../common/simple-logger.js'
import type { ClientStack } from '../core/client-stack.js'
import {
  buildWriteSingleCoil,
  buildWriteSingleRegister,
  buildWriteMultipleRegisters,
  buildMaskWriteRegister,
  buildReadRequest,
  parseReadRegistersResponse,
  parseWriteResponse,
  ModbusExceptionError,
} from '../core/pdu.js'
import { encodeValue } from '../core/datacodec.js'
import { parseObjectAddress, parseAsdu, isBitArea } from '../core/address.js'
import type { TagBinding } from './poll-planner.js'
import type { ModbusClientConnection } from './conn-config.js'

export class CommandHandler {
  private changeStream: ChangeStream | null = null
  private stopped = true

  constructor(
    private readonly cfg: ModbusClientConnection,
    private readonly commandsCollection: Collection,
    private readonly getStack: () => ClientStack | null,
    private readonly getBindings: () => Map<string, TagBinding>
  ) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.watch()
  }

  stop(): void {
    this.stopped = true
    void this.changeStream?.close()
    this.changeStream = null
  }

  private watch(): void {
    if (this.stopped) return
    try {
      const cs = this.commandsCollection.watch(
        [
          {
            $match: {
              operationType: 'insert',
              'fullDocument.protocolSourceConnectionNumber':
                this.cfg.protocolConnectionNumber,
            },
          },
        ],
        { fullDocument: 'updateLookup' }
      )
      this.changeStream = cs
      cs.on('change', (change) => {
        if (change.operationType === 'insert')
          void this.handleCommand(
            change.fullDocument as Record<string, unknown>
          )
      })
      cs.on('error', (err) => {
        Log.log(`${this.cfg.name}: command stream error: ${err}`)
        void cs.close()
        this.changeStream = null
        if (!this.stopped) setTimeout(() => this.watch(), 5000)
      })
    } catch (e) {
      Log.log(`${this.cfg.name}: command watch failed: ${(e as Error).message}`)
      if (!this.stopped) setTimeout(() => this.watch(), 5000)
    }
  }

  private async handleCommand(doc: Record<string, unknown>): Promise<void> {
    if (!this.cfg.commandsEnabled) return
    // Ignore stale commands (older than 10s) to avoid replaying on restart.
    const ts = doc.timeTag instanceof Date ? doc.timeTag.getTime() : Date.now()
    if (Date.now() - ts > 10000) {
      await this.ack(doc, false, 'command expired')
      return
    }

    const stack = this.getStack()
    if (!stack || !stack.connected) {
      await this.ack(doc, false, 'connection down')
      return
    }

    try {
      const objAddr = String(doc.protocolSourceObjectAddress ?? '')
      const addr = parseObjectAddress(objAddr, this.cfg.useModiconAddresses)
      const asdu = parseAsdu(
        (doc.protocolSourceASDU as string) ?? null,
        addr.area,
        {
          byteOrder16: this.cfg.byteOrder16,
          byteOrder32: this.cfg.byteOrder32,
          byteOrder64: this.cfg.byteOrder64,
          byteOrderStr: this.cfg.byteOrderStr,
          stringEncoding: this.cfg.stringEncoding,
        }
      )
      const unitId = clampUnit(doc.protocolSourceCommonAddress)
      const rawValue = Number(doc.value ?? 0)
      const kconv1 = this.lookupKconv(doc, 'kconv1', 1)
      const kconv2 = this.lookupKconv(doc, 'kconv2', 0)

      // Broadcast (unit 0): write, no response expected.
      if (unitId === 0) {
        const pdu = this.buildWritePdu(addr, asdu, doc, rawValue, kconv1, kconv2)
        stack.broadcast(pdu)
        await this.ack(doc, true, 'OK (broadcast, no confirmation)')
        return
      }

      if (isBitArea(addr.area) || asdu.type === 'bool') {
        // digital command
        let on = rawValue !== 0
        if (kconv1 === -1) on = !on
        const pdu = buildWriteSingleCoil(addr.offset, on)
        await this.dispatch(stack, unitId, pdu, doc)
        return
      }

      if (addr.bit !== null) {
        await this.writeBit(stack, unitId, addr.offset, addr.bit, rawValue !== 0, doc)
        return
      }

      const pdu = this.buildWritePdu(addr, asdu, doc, rawValue, kconv1, kconv2)
      await this.dispatch(stack, unitId, pdu, doc)
    } catch (e) {
      await this.ack(doc, false, (e as Error).message)
    }
  }

  private buildWritePdu(
    addr: ReturnType<typeof parseObjectAddress>,
    asdu: ReturnType<typeof parseAsdu>,
    doc: Record<string, unknown>,
    rawValue: number,
    kconv1: number,
    kconv2: number
  ): Buffer {
    // Apply inverse engineering scaling: rawAtSource = (value - k2) / k1.
    let engValue: number | string = rawValue
    if (asdu.type !== 'string' && kconv1 !== 0)
      engValue = (rawValue - kconv2) / kconv1
    if (asdu.type === 'string') engValue = String(doc.valueString ?? '')

    if (asdu.regCount === 1 && asdu.type !== 'string') {
      const wire = encodeValue(asdu.type, engValue, asdu.perm, asdu.str)
      return buildWriteSingleRegister(addr.offset, wire.readUInt16BE(0))
    }
    const wire = encodeValue(asdu.type, engValue, asdu.perm, asdu.str)
    return buildWriteMultipleRegisters(addr.offset, wire)
  }

  private async writeBit(
    stack: ClientStack,
    unitId: number,
    offset: number,
    bit: number,
    on: boolean,
    doc: Record<string, unknown>
  ): Promise<void> {
    if (this.cfg.useMaskWrite) {
      // FC22: AND mask clears the bit, OR mask sets it if `on`.
      const andMask = (~(1 << bit)) & 0xffff
      const orMask = on ? 1 << bit : 0
      const pdu = buildMaskWriteRegister(offset, andMask, orMask)
      await this.dispatch(stack, unitId, pdu, doc)
      return
    }
    // Read-modify-write fallback.
    try {
      const readPdu = buildReadRequest(3, offset, 1)
      const resp = await stack.request(unitId, readPdu, true)
      const regs = parseReadRegistersResponse(resp, 1)
      let word = regs.readUInt16BE(0)
      word = on ? word | (1 << bit) : word & ~(1 << bit)
      const pdu = buildWriteSingleRegister(offset, word & 0xffff)
      await this.dispatch(stack, unitId, pdu, doc)
    } catch (e) {
      await this.ack(doc, false, (e as Error).message)
    }
  }

  private async dispatch(
    stack: ClientStack,
    unitId: number,
    pdu: Buffer,
    doc: Record<string, unknown>
  ): Promise<void> {
    try {
      const resp = await stack.request(unitId, pdu, true) // priority
      parseWriteResponse(resp)
      await this.ack(doc, true, 'OK')
    } catch (e) {
      let reason = (e as Error).message
      if (e instanceof ModbusExceptionError) reason = e.message
      await this.ack(doc, false, reason)
    }
  }

  private lookupKconv(
    doc: Record<string, unknown>,
    field: 'kconv1' | 'kconv2',
    dflt: number
  ): number {
    // Command docs don't carry kconv; look it up from the tag binding by pointKey.
    const key = String(doc.pointKey ?? '')
    const b = this.getBindings().get(key)
    if (b) return field === 'kconv1' ? b.kconv1 : b.kconv2
    const v = Number(doc[field])
    return Number.isFinite(v) ? v : dflt
  }

  private async ack(
    doc: Record<string, unknown>,
    ack: boolean,
    resultDescription: string
  ): Promise<void> {
    try {
      await this.commandsCollection.updateOne(
        { _id: doc._id as never },
        {
          $set: {
            delivered: true,
            ack,
            ackTimeTag: new Date(),
            resultDescription,
          },
        }
      )
      Log.log(
        `${this.cfg.name}: command ${String(doc.tag ?? doc._id)} -> ${
          ack ? 'ACK' : 'NAK'
        } (${resultDescription})`
      )
    } catch (e) {
      Log.log(`${this.cfg.name}: command ack update failed: ${(e as Error).message}`)
    }
  }
}

function clampUnit(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n < 0 || n > 255) return 1
  return n
}
