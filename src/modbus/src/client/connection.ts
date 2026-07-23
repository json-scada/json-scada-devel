/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Manages one MODBUS client connection: transport lifecycle with endpoint
// failover, the poll loop, value publishing, and command dispatch.

import type { Collection } from 'mongodb'
import Log from '../common/simple-logger.js'
import {
  ClientStack,
  rtuIdleGapMs,
  type FramingMode,
} from '../core/client-stack.js'
import type { ClientTransport } from '../core/transport.js'
import { parseHostPort } from '../core/transport.js'
import { TcpClientTransport } from '../core/transport-tcp.js'
import { TlsClientTransport } from '../core/transport-tls.js'
import {
  SerialTransport,
  mapParity,
  mapStopBits,
  mapHandshake,
} from '../core/transport-serial.js'
import {
  parseReadBitsResponse,
  parseReadRegistersResponse,
} from '../core/pdu.js'
import { buildReadRequest } from '../core/pdu.js'
import { decodeValue, type ValueType } from '../core/datacodec.js'
import { isBitArea } from '../core/address.js'
import {
  planReads,
  buildBinding,
  type ReadBlock,
  type TagBinding,
} from './poll-planner.js'
import { RtUpdater } from './rt-updater.js'
import { CommandHandler } from './commands.js'
import {
  isRtuFraming,
  isSerialMode,
  isTlsMode,
  defaultPortForMode,
  type ModbusClientConnection,
} from './conn-config.js'

interface BlockCache {
  lastRaw: Buffer | null
  invalidPublished: boolean
}

export interface ConnectionStats {
  status: string
  connectedTo: string
  requests: number
  errors: number
  timeouts: number
  exceptions: number
  lastError: string
  giCount: number
}

export class ModbusConnection {
  private transport: ClientTransport | null = null
  private stack: ClientStack | null = null
  private endpointIndex = 0
  private bindings: TagBinding[] = []
  private blocks: ReadBlock[] = []
  private blockCache = new Map<ReadBlock, BlockCache>()
  private pollTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private lastGi = 0
  private running = false
  private polling = false
  private backoffMs = 1000
  private commandHandler: CommandHandler
  readonly stats: ConnectionStats = {
    status: 'stopped',
    connectedTo: '',
    requests: 0,
    errors: 0,
    timeouts: 0,
    exceptions: 0,
    lastError: '',
    giCount: 0,
  }

  constructor(
    readonly cfg: ModbusClientConnection,
    private readonly rtCollection: Collection,
    commandsCollection: Collection
  ) {
    this.commandHandler = new CommandHandler(
      cfg,
      commandsCollection,
      () => this.stack,
      () => this.byId
    )
  }

  private byId = new Map<string, TagBinding>()

  // Load / refresh the tag bindings for this connection from realtimeData.
  async loadBindings(): Promise<void> {
    const docs = await this.rtCollection
      .find(
        {
          protocolSourceConnectionNumber: this.cfg.protocolConnectionNumber,
          origin: { $ne: 'command' },
        },
        {
          projection: {
            _id: 1,
            tag: 1,
            protocolSourceObjectAddress: 1,
            protocolSourceASDU: 1,
            protocolSourceCommonAddress: 1,
            kconv1: 1,
            kconv2: 1,
          },
        }
      )
      .toArray()

    const defaults = {
      byteOrder16: this.cfg.byteOrder16,
      byteOrder32: this.cfg.byteOrder32,
      byteOrder64: this.cfg.byteOrder64,
      byteOrderStr: this.cfg.byteOrderStr,
      stringEncoding: this.cfg.stringEncoding,
    }
    const bindings: TagBinding[] = []
    this.byId = new Map()
    for (const d of docs) {
      const { binding, error } = buildBinding(
        {
          id: d._id,
          tag: (d.tag as string) ?? '',
          objectAddress: String(d.protocolSourceObjectAddress ?? ''),
          asdu: (d.protocolSourceASDU as string) ?? null,
          commonAddress: d.protocolSourceCommonAddress,
          kconv1: d.kconv1,
          kconv2: d.kconv2,
        },
        defaults,
        this.cfg.useModiconAddresses
      )
      if (binding) {
        bindings.push(binding)
        this.byId.set(String(d._id), binding)
      } else {
        Log.log(
          `${this.cfg.name}: skipping tag ${String(d.tag)} - ${error}`,
          Log.levelDetailed
        )
      }
    }
    this.bindings = bindings
    this.blocks = planReads(bindings, {
      maxReadRegisters: this.cfg.maxReadRegisters,
      maxReadCoils: this.cfg.maxReadCoils,
      maxAddressGap: this.cfg.maxAddressGap,
      useModicon: this.cfg.useModiconAddresses,
    })
    this.blockCache = new Map()
    for (const b of this.blocks) this.blockCache.set(b, { lastRaw: null, invalidPublished: false })
    Log.log(
      `${this.cfg.name}: ${bindings.length} tags in ${this.blocks.length} read blocks`,
      Log.levelNormal
    )
    if (Log.levelCurrent >= Log.levelDetailed) {
      for (const b of this.blocks)
        Log.log(
          `  block unit=${b.unitId} ${b.area}:${b.startAddr} x${b.count} (${b.slices.length} tags)`,
          Log.levelDetailed
        )
    }
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.connectWithFailover()
  }

  stop(): void {
    this.running = false
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.pollTimer = null
    this.reconnectTimer = null
    this.commandHandler.stop()
    this.transport?.close()
    this.transport = null
    this.stack = null
    this.stats.status = 'stopped'
    this.stats.connectedTo = ''
  }

  private buildTransport(): ClientTransport {
    const mode = this.cfg.connectionMode
    if (isSerialMode(mode)) {
      const hs = mapHandshake(this.cfg.handshake)
      return new SerialTransport({
        portName: this.cfg.portName,
        baudRate: this.cfg.baudRate,
        parity: mapParity(this.cfg.parity),
        stopBits: mapStopBits(this.cfg.stopBits),
        dataBits: 8,
        ...hs,
      })
    }
    const endpoints = this.cfg.ipAddresses.length
      ? this.cfg.ipAddresses
      : ['127.0.0.1']
    const ep = endpoints[this.endpointIndex % endpoints.length]!
    const { host, port } = parseHostPort(ep, defaultPortForMode(mode))
    if (isTlsMode(mode)) {
      return new TlsClientTransport({
        host,
        port,
        localBind: this.cfg.ipAddressLocalBind,
        connectTimeoutMs: Math.max(3000, this.cfg.timeoutMs * 3),
        tls: this.cfg.tls,
      })
    }
    return new TcpClientTransport({
      host,
      port,
      localBind: this.cfg.ipAddressLocalBind,
      connectTimeoutMs: Math.max(3000, this.cfg.timeoutMs * 3),
    })
  }

  private async connectWithFailover(): Promise<void> {
    if (!this.running) return
    this.stats.status = 'connecting'
    const transport = this.buildTransport()
    this.transport = transport
    this.stats.connectedTo = transport.describe()

    const mode: FramingMode = isRtuFraming(this.cfg.connectionMode)
      ? 'rtu'
      : 'mbap'
    const idleGap = rtuIdleGapMs(this.cfg.baudRate, this.cfg.interFrameDelayMs)
    const stack = new ClientStack(
      transport,
      mode,
      {
        responseTimeoutMs: this.cfg.timeoutMs,
        maxRetries: this.cfg.maxRetries,
        interRequestDelayMs: this.cfg.interRequestDelayMs,
        interFrameDelayMs: this.cfg.interFrameDelayMs,
      },
      idleGap
    )
    this.stack = stack
    stack.on('retry', () => {
      this.stats.timeouts++
    })
    stack.on('error', (e: Error) => {
      this.stats.lastError = e.message
    })
    stack.on('linkdown', () => this.onDisconnect())

    try {
      await transport.connect()
      Log.log(`${this.cfg.name}: connected to ${transport.describe()}`)
      this.stats.status = 'connected'
      this.backoffMs = 1000
      this.lastGi = 0
      if (this.cfg.commandsEnabled) this.commandHandler.start()
      this.scheduleNextPoll(0)
    } catch (e) {
      Log.log(
        `${this.cfg.name}: connect failed (${transport.describe()}): ${(e as Error).message}`
      )
      this.stats.lastError = (e as Error).message
      this.onDisconnect()
    }
  }

  private onDisconnect(): void {
    if (!this.running) return
    this.stats.status = 'disconnected'
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.commandHandler.stop()
    this.transport?.close()
    this.transport = null
    this.stack = null
    // Mark all tags invalid once on link loss.
    void this.publishAllInvalid()
    // advance endpoint for failover, then reconnect with backoff
    const endpoints = this.cfg.ipAddresses.length || 1
    this.endpointIndex = (this.endpointIndex + 1) % endpoints
    const wait = this.backoffMs
    this.backoffMs = Math.min(30000, this.backoffMs * 2)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.connectWithFailover(), wait)
  }

  private scheduleNextPoll(delayMs: number): void {
    if (!this.running) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => void this.pollCycle(), delayMs)
  }

  private async pollCycle(): Promise<void> {
    if (!this.running || !this.stack || !this.stack.connected) return
    if (this.polling) {
      this.scheduleNextPoll(this.cfg.pollingIntervalMs)
      return
    }
    this.polling = true
    const start = Date.now()
    const isGi =
      this.lastGi === 0 ||
      Date.now() - this.lastGi >= this.cfg.giIntervalS * 1000
    if (isGi) {
      this.lastGi = Date.now()
      this.stats.giCount++
    }

    const updater = new RtUpdater(
      this.rtCollection,
      this.cfg.protocolConnectionNumber
    )
    try {
      for (const block of this.blocks) {
        if (!this.stack || !this.stack.connected) break
        await this.readBlock(block, updater, isGi)
      }
      await updater.flush()
    } catch (e) {
      Log.log(`${this.cfg.name}: poll error: ${(e as Error).message}`, Log.levelDetailed)
    } finally {
      this.polling = false
      const elapsed = Date.now() - start
      const wait = Math.max(0, this.cfg.pollingIntervalMs - elapsed)
      this.scheduleNextPoll(wait)
    }
  }

  private async readBlock(
    block: ReadBlock,
    updater: RtUpdater,
    isGi: boolean
  ): Promise<void> {
    const cache = this.blockCache.get(block)!
    const req = buildReadRequest(block.fc, block.startAddr, block.count)
    try {
      this.stats.requests++
      const respPdu = await this.stack!.request(block.unitId, req)
      let raw: Buffer
      if (isBitArea(block.area)) {
        const bits = parseReadBitsResponse(respPdu, block.count)
        raw = Buffer.alloc(Math.ceil(block.count / 8))
        for (let i = 0; i < bits.length; i++)
          if (bits[i]) raw[i >> 3]! |= 1 << (i & 7)
      } else {
        raw = parseReadRegistersResponse(respPdu, block.count)
      }
      const changed =
        cache.lastRaw === null || !raw.equals(cache.lastRaw) || isGi
      cache.invalidPublished = false
      if (changed) {
        this.decodeAndQueue(block, raw, updater, isGi)
        cache.lastRaw = Buffer.from(raw)
      }
    } catch (e) {
      const msg = (e as Error).message
      if (msg.includes('exception')) this.stats.exceptions++
      else if (msg.includes('timeout')) this.stats.timeouts++
      else this.stats.errors++
      this.stats.lastError = msg
      if (!cache.invalidPublished) {
        updater.queueInvalid(block.slices.map((s) => s.binding.id))
        cache.invalidPublished = true
        cache.lastRaw = null
      }
    }
  }

  private decodeAndQueue(
    block: ReadBlock,
    raw: Buffer,
    updater: RtUpdater,
    isGi: boolean
  ): void {
    const bitArea = isBitArea(block.area)
    for (const slice of block.slices) {
      const b = slice.binding
      try {
        let value: number | bigint | boolean | string
        let invalid = false
        let json: unknown
        let type: ValueType = b.asdu.type
        if (bitArea) {
          const bit = (raw[slice.relStart >> 3]! >> (slice.relStart & 7)) & 1
          value = b.kconv1 === -1 ? bit === 0 : bit === 1
          type = 'bool'
        } else if (b.bit !== null) {
          const dec = decodeValue('uint16', raw, slice.relStart, b.asdu.perm)
          const word = Number(dec.value)
          value = ((word >> b.bit) & 1) === 1
          type = 'bool'
        } else {
          const dec = decodeValue(
            b.asdu.type,
            raw,
            slice.relStart,
            b.asdu.perm,
            b.asdu.str
          )
          invalid = dec.invalid
          json = dec.json
          if (
            typeof dec.value === 'number' &&
            b.asdu.type !== 'string'
          ) {
            value = dec.value * b.kconv1 + b.kconv2
          } else {
            value = dec.value
          }
        }
        updater.queue({
          id: b.id,
          value,
          valueString:
            typeof value === 'string' ? value : String(value),
          valueJson: json,
          type,
          asduLabel: this.asduLabel(b),
          invalid,
          cot: isGi ? '20' : '3',
        })
      } catch (e) {
        Log.log(
          `${this.cfg.name}: decode error tag ${b.tag}: ${(e as Error).message}`,
          Log.levelDetailed
        )
        updater.queueInvalid([b.id])
      }
    }
  }

  private asduLabel(b: TagBinding): string {
    return b.asdu.byteOrder
      ? `${b.asdu.type}_${b.asdu.byteOrder.toLowerCase()}`
      : b.asdu.type
  }

  private async publishAllInvalid(): Promise<void> {
    if (this.bindings.length === 0) return
    const updater = new RtUpdater(
      this.rtCollection,
      this.cfg.protocolConnectionNumber
    )
    updater.queueInvalid(this.bindings.map((b) => b.id))
    try {
      await updater.flush()
    } catch (e) {
      Log.log(`${this.cfg.name}: invalidate error: ${(e as Error).message}`)
    }
  }
}
