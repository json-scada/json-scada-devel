/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Relays Modbus master writes into JSON-SCADA commands. A write to a mapped
// command point is turned into a commandsQueue insert carrying the point's
// protocolSource* routing, exactly as the UI does, so whichever client driver
// owns that point dispatches it to the field device.

import { Double, type Collection } from 'mongodb'
import Log from '../common/simple-logger.js'
import { EXCEPTION } from '../core/pdu.js'
import type { HandlerResult } from '../core/server-stack.js'
import type { PointMap, ServerPoint } from './point-map.js'
import type { ModbusServerConnection } from './conn-config.js'

export class WriteHandler {
  constructor(
    private readonly cfg: ModbusServerConnection,
    private readonly commands: Collection,
    private readonly map: PointMap
  ) {}

  // Handle a single-coil write. Returns echo (accepted) or exception.
  handleCoilWrite(unitId: number, addr: number, on: boolean, remote: string): HandlerResult {
    const point = this.map.lookupWrite(unitId, 'co', addr)
    return this.relay(point, on ? 1 : 0, on ? '1' : '0', remote)
  }

  // Handle a single-register write.
  handleRegisterWrite(
    unitId: number,
    addr: number,
    value: number,
    remote: string
  ): HandlerResult {
    const point = this.map.lookupWrite(unitId, 'hr', addr)
    if (!point) return this.unmapped()
    const reg = Buffer.alloc(2)
    reg.writeUInt16BE(value & 0xffff, 0)
    return this.relayDecoded(point, reg, remote)
  }

  // Handle a multi-coil write covering [start, start+bits.length).
  handleMultiCoilWrite(
    unitId: number,
    start: number,
    bits: boolean[],
    remote: string
  ): HandlerResult {
    let anyMapped = false
    for (let i = 0; i < bits.length; i++) {
      const point = this.map.lookupWrite(unitId, 'co', start + i)
      if (point && point.offset === start + i) {
        anyMapped = true
        const r = this.relay(point, bits[i] ? 1 : 0, bits[i] ? '1' : '0', remote)
        if (r.kind === 'exception') return r
      }
    }
    return anyMapped ? { kind: 'echo' } : this.unmapped()
  }

  // Handle a multi-register write. Decompose into the mapped points it covers.
  handleMultiRegisterWrite(
    unitId: number,
    start: number,
    registers: Buffer,
    remote: string
  ): HandlerResult {
    const qty = registers.length / 2
    const covered = new Set<ServerPoint>()
    for (let i = 0; i < qty; i++) {
      const point = this.map.lookupWrite(unitId, 'hr', start + i)
      if (point) covered.add(point)
    }
    if (covered.size === 0) return this.unmapped()
    for (const point of covered) {
      // Extract this point's registers from the written block.
      const rel = point.offset - start
      if (rel < 0 || rel + point.span > qty) continue // partial write: skip
      const slice = registers.subarray(rel * 2, (rel + point.span) * 2)
      const r = this.relayDecoded(point, Buffer.from(slice), remote)
      if (r.kind === 'exception') return r
    }
    return { kind: 'echo' }
  }

  // Handle a mask-write to a bit-in-register command point.
  handleMaskWrite(
    unitId: number,
    addr: number,
    andMask: number,
    orMask: number,
    remote: string
  ): HandlerResult {
    const point = this.map.lookupWrite(unitId, 'hr', addr)
    if (!point || point.bit === null) return this.unmapped()
    // Resulting bit value: (current AND andMask) OR orMask, evaluated at the bit.
    const on = ((orMask >> point.bit) & 1) === 1 || ((andMask >> point.bit) & 1) === 1
    return this.relay(point, on ? 1 : 0, on ? '1' : '0', remote)
  }

  private relayDecoded(
    point: ServerPoint,
    registers: Buffer,
    remote: string
  ): HandlerResult {
    try {
      const { value, valueString } = this.map.decodeWrittenRegisters(point, registers)
      const numVal = typeof value === 'bigint' ? Number(value) : Number(value)
      return this.relay(point, numVal, valueString, remote)
    } catch (e) {
      Log.log(`${this.cfg.name}: decode write error: ${(e as Error).message}`)
      return { kind: 'exception', code: EXCEPTION.ILLEGAL_DATA_VALUE }
    }
  }

  private relay(
    point: ServerPoint | undefined,
    value: number,
    valueString: string,
    remote: string
  ): HandlerResult {
    if (!point) return this.unmapped()
    if (!this.cfg.commandsEnabled)
      return { kind: 'exception', code: EXCEPTION.ILLEGAL_FUNCTION }
    if (!point.isCommand) {
      if (this.cfg.allowWritesToSupervised) {
        // Direct write into the supervised value (register bank use-case).
        this.map.encodeInto(point, value, valueString, false)
        return { kind: 'echo' }
      }
      return { kind: 'exception', code: EXCEPTION.ILLEGAL_FUNCTION }
    }

    // Fire-and-forget the insert; Modbus cannot wait for end-to-end confirmation.
    this.insertCommand(point, value, valueString, remote).catch((e) => {
      Log.log(`${this.cfg.name}: command insert failed: ${(e as Error).message}`)
    })
    return { kind: 'echo' }
  }

  private async insertCommand(
    point: ServerPoint,
    value: number,
    valueString: string,
    remote: string
  ): Promise<void> {
    await this.commands.insertOne({
      protocolSourceConnectionNumber: new Double(point.cmdConnectionNumber ?? 0),
      protocolSourceCommonAddress:
        point.cmdCommonAddress === null
          ? null
          : new Double(point.cmdCommonAddress),
      protocolSourceObjectAddress: point.cmdObjectAddress,
      protocolSourceASDU: point.cmdAsdu,
      protocolSourceCommandDuration: new Double(0),
      protocolSourceCommandUseSBO: false,
      pointKey: new Double(point.pointKey),
      tag: point.tag,
      timeTag: new Date(),
      value: new Double(value),
      valueString,
      originatorUserName: 'Protocol connection: ' + this.cfg.name,
      originatorIpAddress: remote,
    })
    Log.log(
      `${this.cfg.name}: relayed write to command ${point.tag} value=${value} from ${remote}`
    )
  }

  private unmapped(): HandlerResult {
    return { kind: 'exception', code: EXCEPTION.ILLEGAL_DATA_ADDRESS }
  }
}
