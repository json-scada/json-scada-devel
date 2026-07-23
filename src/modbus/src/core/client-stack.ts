/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Client (master) protocol stack. Sits on a ClientTransport and provides a
// promise-based request/response API with a single outstanding transaction per
// link (as Modbus requires), per-request timeout, retries, and idle-gap framing
// for RTU. Reconnect/failover across multiple endpoints is handled here too.

import { EventEmitter } from 'node:events'
import type { ClientTransport } from './transport.js'
import {
  encodeMbap,
  MbapDecoder,
  TransactionIdGenerator,
} from './framing-mbap.js'
import { encodeRtu, RtuResponseDecoder } from './framing-rtu.js'

export type FramingMode = 'mbap' | 'rtu'

export interface ClientStackTiming {
  responseTimeoutMs: number
  maxRetries: number
  interRequestDelayMs: number
  interFrameDelayMs: number // 0 = auto; RTU idle-gap delimiter
}

interface PendingRequest {
  unitId: number
  pdu: Buffer
  transactionId: number
  priority: boolean
  resolve: (pdu: Buffer) => void
  reject: (err: Error) => void
  retriesLeft: number
  timer: NodeJS.Timeout | null
}

// Default RTU idle-gap: 3.5 char times at the given baud, min 2 ms.
export function rtuIdleGapMs(baudRate: number, override: number): number {
  if (override > 0) return override
  const charBits = 11 // 8 data + start + stop + parity, worst case
  const ms = (3.5 * charBits * 1000) / Math.max(1, baudRate)
  return Math.max(2, Math.ceil(ms))
}

export class ClientStack extends EventEmitter {
  private readonly mbapDecoder = new MbapDecoder()
  private readonly rtuDecoder = new RtuResponseDecoder()
  private readonly txnGen = new TransactionIdGenerator()
  private readonly queue: PendingRequest[] = []
  private current: PendingRequest | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private pumping = false

  constructor(
    private readonly transport: ClientTransport,
    private readonly mode: FramingMode,
    private readonly timing: ClientStackTiming,
    private readonly idleGapMs: number
  ) {
    super()
    transport.on('data', (d: Buffer) => this.onData(d))
    transport.on('close', () => this.onLinkDown(new Error('link closed')))
    transport.on('error', (e: Error) => this.emit('error', e))
  }

  get connected(): boolean {
    return this.transport.isConnected
  }

  // Enqueue a request. `priority` jumps commands ahead of polling.
  request(unitId: number, pdu: Buffer, priority = false): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const req: PendingRequest = {
        unitId,
        pdu,
        transactionId: 0,
        priority,
        resolve,
        reject,
        retriesLeft: this.timing.maxRetries,
        timer: null,
      }
      if (priority) {
        // insert after the current in-flight slot, before other pollers
        this.queue.unshift(req)
      } else {
        this.queue.push(req)
      }
      void this.pump()
    })
  }

  // Broadcast write (unit id 0): send, no response expected.
  broadcast(pdu: Buffer): void {
    const frame =
      this.mode === 'mbap'
        ? encodeMbap(this.txnGen.allocate(), 0, pdu)
        : encodeRtu(0, pdu)
    this.transport.write(frame)
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (!this.current && this.queue.length && this.transport.isConnected) {
        const req = this.queue.shift()!
        this.current = req
        this.send(req)
        // Wait until the current request settles before sending the next.
        // The settle happens in onData/onTimeout which clears this.current.
        await this.waitSettle()
        if (this.timing.interRequestDelayMs > 0)
          await delay(this.timing.interRequestDelayMs)
      }
    } finally {
      this.pumping = false
    }
  }

  private settleWaiters: Array<() => void> = []
  private waitSettle(): Promise<void> {
    return new Promise((resolve) => this.settleWaiters.push(resolve))
  }
  private signalSettle(): void {
    const waiters = this.settleWaiters
    this.settleWaiters = []
    for (const w of waiters) w()
  }

  private send(req: PendingRequest): void {
    if (this.mode === 'mbap') {
      req.transactionId = this.txnGen.allocate()
      this.transport.write(encodeMbap(req.transactionId, req.unitId, req.pdu))
    } else {
      this.rtuDecoder.expectResponseTo(req.pdu)
      this.transport.write(encodeRtu(req.unitId, req.pdu))
    }
    req.timer = setTimeout(
      () => this.onTimeout(req),
      this.timing.responseTimeoutMs
    )
  }

  private onData(chunk: Buffer): void {
    if (this.mode === 'mbap') {
      const { frames, fatal } = this.mbapDecoder.push(chunk)
      if (fatal) {
        this.onLinkDown(new Error('MBAP desynchronization'))
        return
      }
      for (const f of frames) this.matchMbap(f.transactionId, f.pdu)
    } else {
      // RTU: feed decoder, and (re)arm the idle-gap timer so a short/last frame
      // still completes even without length prediction.
      const frame = this.rtuDecoder.push(chunk)
      if (frame) {
        this.completeCurrent(frame.pdu)
      } else {
        this.armIdleTimer()
      }
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      const frame = this.rtuDecoder.onIdle()
      if (frame) this.completeCurrent(frame.pdu)
    }, this.idleGapMs)
  }

  private matchMbap(transactionId: number, pdu: Buffer): void {
    if (this.current && this.current.transactionId === transactionId) {
      this.completeCurrent(pdu)
    }
    // Unmatched responses (late/duplicate) are ignored.
  }

  private completeCurrent(pdu: Buffer): void {
    const req = this.current
    if (!req) return
    if (req.timer) clearTimeout(req.timer)
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    this.current = null
    req.resolve(pdu)
    this.signalSettle()
    void this.pump()
  }

  private onTimeout(req: PendingRequest): void {
    if (this.current !== req) return
    if (req.retriesLeft > 0) {
      req.retriesLeft--
      this.emit('retry', req.unitId)
      // resend same request
      if (this.mode === 'rtu') this.rtuDecoder.reset()
      this.send(req)
      return
    }
    this.current = null
    if (this.mode === 'rtu') this.rtuDecoder.reset()
    req.reject(new Error('response timeout'))
    this.signalSettle()
    void this.pump()
  }

  private onLinkDown(err: Error): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const failAll = (r: PendingRequest) => {
      if (r.timer) clearTimeout(r.timer)
      r.reject(err)
    }
    if (this.current) {
      failAll(this.current)
      this.current = null
    }
    while (this.queue.length) failAll(this.queue.shift()!)
    this.mbapDecoder.reset()
    this.rtuDecoder.reset()
    this.signalSettle()
    this.emit('linkdown', err)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
