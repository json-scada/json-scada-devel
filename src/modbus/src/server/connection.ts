/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Manages one MODBUS_SERVER connection: the listener, per-client protocol stacks,
// the point map fed by realtimeData, and the RequestHandler that serves reads and
// relays writes.

import type { Collection } from 'mongodb'
import Log from '../common/simple-logger.js'
import {
  ServerStackLink,
  type RequestHandler,
  type RequestContext,
  type HandlerResult,
  type ServerLink,
} from '../core/server-stack.js'
import type { FramingMode } from '../core/client-stack.js'
import {
  TcpServerListener,
  TlsServerListener,
  SerialServerListener,
  type ServerListener,
} from '../core/transport-server.js'
import {
  mapParity,
  mapStopBits,
  mapHandshake,
} from '../core/transport-serial.js'
import { EXCEPTION } from '../core/pdu.js'
import { PointMap } from './point-map.js'
import { RtWatcher } from './rt-watcher.js'
import { WriteHandler } from './write-handler.js'
import {
  isRtuServerFraming,
  isSerialServerMode,
  isTlsServerMode,
  defaultServerPort,
  type ModbusServerConnection,
} from './conn-config.js'

export interface ServerStats {
  status: string
  clients: number
  reads: number
  writes: number
  exceptions: number
  lastError: string
}

export class ModbusServer implements RequestHandler {
  private listener: ServerListener | null = null
  private map: PointMap
  private watcher: RtWatcher
  private writeHandler: WriteHandler
  private running = false
  private clientCount = 0
  readonly stats: ServerStats = {
    status: 'stopped',
    clients: 0,
    reads: 0,
    writes: 0,
    exceptions: 0,
    lastError: '',
  }

  constructor(
    readonly cfg: ModbusServerConnection,
    rtCollection: Collection,
    commandsCollection: Collection
  ) {
    this.map = new PointMap(cfg)
    this.watcher = new RtWatcher(cfg, rtCollection, this.map)
    this.writeHandler = new WriteHandler(cfg, commandsCollection, this.map)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.watcher.start()
    await this.startListener()
  }

  stop(): void {
    this.running = false
    this.watcher.stop()
    this.listener?.close()
    this.listener = null
    this.stats.status = 'stopped'
  }

  private async startListener(): Promise<void> {
    const mode = this.cfg.connectionMode
    const framing: FramingMode = isRtuServerFraming(mode) ? 'rtu' : 'mbap'

    if (isSerialServerMode(mode)) {
      const hs = mapHandshake(this.cfg.handshake)
      this.listener = new SerialServerListener({
        portName: this.cfg.portName,
        baudRate: this.cfg.baudRate,
        parity: mapParity(this.cfg.parity),
        stopBits: mapStopBits(this.cfg.stopBits),
        dataBits: 8,
        ...hs,
      })
    } else if (isTlsServerMode(mode)) {
      this.listener = new TlsServerListener({
        bind: this.cfg.ipAddressLocalBind,
        defaultPort: defaultServerPort(mode),
        maxClients: this.cfg.maxClientConnections,
        idleTimeoutMs: this.cfg.clientIdleTimeoutMs,
        allowList: this.cfg.ipAddresses,
        tls: this.cfg.tls,
      })
    } else {
      this.listener = new TcpServerListener({
        bind: this.cfg.ipAddressLocalBind,
        defaultPort: defaultServerPort(mode),
        maxClients: this.cfg.maxClientConnections,
        idleTimeoutMs: this.cfg.clientIdleTimeoutMs,
        allowList: this.cfg.ipAddresses,
      })
    }

    this.listener.on('connection', (link: ServerLink) =>
      this.onClient(link, framing)
    )
    this.listener.on('error', (e: Error) => {
      this.stats.lastError = e.message
      Log.log(`${this.cfg.name}: listener error: ${e.message}`)
    })
    this.listener.on('listening', () => {
      this.stats.status = 'listening'
      Log.log(`${this.cfg.name}: listening (${mode})`)
    })

    try {
      await this.listener.listen()
    } catch (e) {
      this.stats.lastError = (e as Error).message
      Log.log(`${this.cfg.name}: listen failed: ${(e as Error).message}`)
      if (this.running) setTimeout(() => void this.startListener(), 5000)
    }
  }

  private onClient(link: ServerLink, framing: FramingMode): void {
    this.clientCount++
    this.stats.clients = this.clientCount
    Log.log(`${this.cfg.name}: client connected ${link.describe()}`, Log.levelDetailed)
    const stackLink = new ServerStackLink(
      link,
      framing,
      this,
      this.cfg.strictUnitId
    )
    stackLink.on('close', () => {
      this.clientCount = Math.max(0, this.clientCount - 1)
      this.stats.clients = this.clientCount
    })
  }

  // ----- RequestHandler implementation -----

  acceptsUnit(unitId: number): boolean {
    return this.map.acceptsUnit(unitId)
  }

  readCoils(ctx: RequestContext, start: number, qty: number): HandlerResult {
    this.stats.reads++
    const bits = this.map.readBits(ctx.unitId, 'co', start, qty)
    return bits ? { kind: 'bits', bits } : this.badAddress()
  }

  readDiscreteInputs(ctx: RequestContext, start: number, qty: number): HandlerResult {
    this.stats.reads++
    const bits = this.map.readBits(ctx.unitId, 'di', start, qty)
    return bits ? { kind: 'bits', bits } : this.badAddress()
  }

  readHolding(ctx: RequestContext, start: number, qty: number): HandlerResult {
    this.stats.reads++
    const regs = this.map.readRegisters(ctx.unitId, 'hr', start, qty)
    return regs ? { kind: 'registers', registers: regs } : this.badAddress()
  }

  readInput(ctx: RequestContext, start: number, qty: number): HandlerResult {
    this.stats.reads++
    const regs = this.map.readRegisters(ctx.unitId, 'ir', start, qty)
    return regs ? { kind: 'registers', registers: regs } : this.badAddress()
  }

  writeSingleCoil(ctx: RequestContext, addr: number, on: boolean): HandlerResult {
    this.stats.writes++
    return this.track(this.writeHandler.handleCoilWrite(ctx.unitId, addr, on, ctx.remote))
  }

  writeSingleRegister(ctx: RequestContext, addr: number, value: number): HandlerResult {
    this.stats.writes++
    return this.track(
      this.writeHandler.handleRegisterWrite(ctx.unitId, addr, value, ctx.remote)
    )
  }

  writeMultipleCoils(ctx: RequestContext, start: number, bits: boolean[]): HandlerResult {
    this.stats.writes++
    return this.track(
      this.writeHandler.handleMultiCoilWrite(ctx.unitId, start, bits, ctx.remote)
    )
  }

  writeMultipleRegisters(
    ctx: RequestContext,
    start: number,
    registers: Buffer
  ): HandlerResult {
    this.stats.writes++
    return this.track(
      this.writeHandler.handleMultiRegisterWrite(ctx.unitId, start, registers, ctx.remote)
    )
  }

  maskWriteRegister(
    ctx: RequestContext,
    addr: number,
    andMask: number,
    orMask: number
  ): HandlerResult {
    this.stats.writes++
    return this.track(
      this.writeHandler.handleMaskWrite(ctx.unitId, addr, andMask, orMask, ctx.remote)
    )
  }

  private track(r: HandlerResult): HandlerResult {
    if (r.kind === 'exception') this.stats.exceptions++
    return r
  }

  private badAddress(): HandlerResult {
    this.stats.exceptions++
    return { kind: 'exception', code: EXCEPTION.ILLEGAL_DATA_ADDRESS }
  }
}
