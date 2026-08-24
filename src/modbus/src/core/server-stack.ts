/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Server (slave) protocol stack. Wraps a per-client byte stream with the right
// framing (MBAP or RTU), parses requests, delegates to a RequestHandler, and
// writes framed responses. Transport-agnostic: TCP/TLS listeners and the serial
// port all feed the same ServerLink abstraction.

import { EventEmitter } from 'node:events'
import {
  FC,
  EXCEPTION,
  parseReadRequest,
  parseWriteSingleRequest,
  parseWriteMultipleCoilsRequest,
  parseWriteMultipleRegistersRequest,
  parseMaskWriteRequest,
  buildReadBitsResponse,
  buildReadRegistersResponse,
  buildExceptionResponse,
  buildWriteEchoResponse,
} from './pdu.js'
import { encodeMbap, MbapDecoder } from './framing-mbap.js'
import { encodeRtu, RtuRequestDecoder } from './framing-rtu.js'
import type { FramingMode } from './client-stack.js'
import {
  NoopLogger,
  hex,
  describeRequest,
  describeResponse,
  exceptionName,
  type StackLogger,
} from './logging.js'

// One connected client link (a Duplex byte pipe).
export interface ServerLink extends EventEmitter {
  write(data: Buffer): void
  close(): void
  describe(): string
  // events: 'data' (Buffer), 'close'
}

// Result of handling a request: either response bits/registers, an echo (writes),
// or an exception code.
export type HandlerResult =
  | { kind: 'bits'; bits: boolean[] }
  | { kind: 'registers'; registers: Buffer }
  | { kind: 'echo' }
  | { kind: 'exception'; code: number }

export interface RequestContext {
  unitId: number
  remote: string
}

export interface RequestHandler {
  // Which unit ids this server answers. For TCP non-strict mode, return true for any.
  acceptsUnit(unitId: number): boolean
  readCoils(ctx: RequestContext, start: number, qty: number): HandlerResult
  readDiscreteInputs(ctx: RequestContext, start: number, qty: number): HandlerResult
  readHolding(ctx: RequestContext, start: number, qty: number): HandlerResult
  readInput(ctx: RequestContext, start: number, qty: number): HandlerResult
  writeSingleCoil(ctx: RequestContext, addr: number, on: boolean): HandlerResult
  writeSingleRegister(ctx: RequestContext, addr: number, value: number): HandlerResult
  writeMultipleCoils(
    ctx: RequestContext,
    start: number,
    bits: boolean[]
  ): HandlerResult
  writeMultipleRegisters(
    ctx: RequestContext,
    start: number,
    registers: Buffer
  ): HandlerResult
  maskWriteRegister(
    ctx: RequestContext,
    addr: number,
    andMask: number,
    orMask: number
  ): HandlerResult
}

const MAX_READ_BITS = 2000
const MAX_READ_REGS = 125

// Attach the server protocol handling to a single client link.
export class ServerStackLink extends EventEmitter {
  private readonly mbapDecoder = new MbapDecoder()
  private readonly rtuDecoder = new RtuRequestDecoder()

  constructor(
    private readonly link: ServerLink,
    private readonly mode: FramingMode,
    private readonly handler: RequestHandler,
    private readonly strictUnitId: boolean,
    private readonly log: StackLogger = NoopLogger
  ) {
    super()
    link.on('data', (d: Buffer) => {
      if (this.log.debugEnabled)
        this.log.debug(
          `[${link.describe()}] link RX ${d.length} bytes: ${hex(d)}`
        )
      this.onData(d)
    })
    link.on('close', () => this.emit('close'))
  }

  private onData(chunk: Buffer): void {
    if (this.mode === 'mbap') {
      const { frames, fatal } = this.mbapDecoder.push(chunk)
      if (fatal) {
        this.log.error(
          `[${this.link.describe()}] malformed MBAP header, closing client ` +
            `(chunk: ${hex(chunk, 32)})`
        )
        this.link.close()
        return
      }
      for (const f of frames) {
        if (this.log.debugEnabled)
          this.log.debug(
            `[${this.link.describe()}] RX unit=${f.unitId} txn=${f.transactionId} ` +
              `${describeRequest(f.pdu)} | PDU: ${hex(f.pdu)}`
          )
        const resp = this.dispatch(f.unitId)
        if (!resp) continue
        const respPdu = resp(f.pdu)
        const adu = encodeMbap(f.transactionId, f.unitId, respPdu)
        if (this.log.debugEnabled)
          this.log.debug(
            `[${this.link.describe()}] TX unit=${f.unitId} txn=${f.transactionId} ` +
              `${describeResponse(respPdu)} | ADU: ${hex(adu)}`
          )
        this.link.write(adu)
      }
    } else {
      const frames = this.rtuDecoder.push(chunk)
      for (const f of frames) {
        if (this.log.debugEnabled)
          this.log.debug(
            `[${this.link.describe()}] RX unit=${f.unitId} ` +
              `${describeRequest(f.pdu)} | PDU: ${hex(f.pdu)}`
          )
        // Broadcast (unit 0): execute, do not respond.
        const resp = this.dispatch(f.unitId)
        if (!resp) continue
        if (f.unitId === 0) {
          resp(f.pdu) // execute side effects, discard response
          this.log.debug(
            `[${this.link.describe()}] broadcast executed, no response sent`
          )
          continue
        }
        const respPdu = resp(f.pdu)
        const adu = encodeRtu(f.unitId, respPdu)
        if (this.log.debugEnabled)
          this.log.debug(
            `[${this.link.describe()}] TX unit=${f.unitId} ` +
              `${describeResponse(respPdu)} | ADU: ${hex(adu)}`
          )
        this.link.write(adu)
      }
    }
  }

  // Returns a function that produces the response PDU, or null to ignore the
  // frame entirely (unit id not for us in strict mode).
  private dispatch(unitId: number): ((pdu: Buffer) => Buffer) | null {
    if (unitId !== 0 && this.strictUnitId && !this.handler.acceptsUnit(unitId)) {
      this.log.info(
        `[${this.link.describe()}] request ignored: unit id ${unitId} not served ` +
          `(strictUnitId is enabled)`
      )
      return null
    }
    const ctx: RequestContext = { unitId, remote: this.link.describe() }
    return (pdu: Buffer) => this.handlePdu(ctx, pdu)
  }

  // Report an exception answered to a master. These are request errors: the
  // master asked for something this server could not serve.
  private logException(ctx: RequestContext, fc: number, code: number, req: Buffer): void {
    this.log.error(
      `[${ctx.remote}] request error: unit=${ctx.unitId} ${describeRequest(req)} ` +
        `-> exception ${exceptionName(code)}`
    )
    void fc
  }

  private handlePdu(ctx: RequestContext, pdu: Buffer): Buffer {
    const fc = pdu.readUInt8(0)
    try {
      switch (fc) {
        case FC.READ_COILS: {
          const r = parseReadRequest(pdu)
          if (r.quantity < 1 || r.quantity > MAX_READ_BITS) {
            this.logException(ctx, fc, EXCEPTION.ILLEGAL_DATA_VALUE, pdu)
            return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_DATA_VALUE)
          }
          return this.toResponse(fc, this.handler.readCoils(ctx, r.startAddr, r.quantity), ctx, pdu)
        }
        case FC.READ_DISCRETE_INPUTS: {
          const r = parseReadRequest(pdu)
          if (r.quantity < 1 || r.quantity > MAX_READ_BITS) {
            this.logException(ctx, fc, EXCEPTION.ILLEGAL_DATA_VALUE, pdu)
            return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_DATA_VALUE)
          }
          return this.toResponse(
            fc,
            this.handler.readDiscreteInputs(ctx, r.startAddr, r.quantity),
            ctx,
            pdu
          )
        }
        case FC.READ_HOLDING_REGISTERS: {
          const r = parseReadRequest(pdu)
          if (r.quantity < 1 || r.quantity > MAX_READ_REGS) {
            this.logException(ctx, fc, EXCEPTION.ILLEGAL_DATA_VALUE, pdu)
            return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_DATA_VALUE)
          }
          return this.toResponse(fc, this.handler.readHolding(ctx, r.startAddr, r.quantity), ctx, pdu)
        }
        case FC.READ_INPUT_REGISTERS: {
          const r = parseReadRequest(pdu)
          if (r.quantity < 1 || r.quantity > MAX_READ_REGS) {
            this.logException(ctx, fc, EXCEPTION.ILLEGAL_DATA_VALUE, pdu)
            return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_DATA_VALUE)
          }
          return this.toResponse(fc, this.handler.readInput(ctx, r.startAddr, r.quantity), ctx, pdu)
        }
        case FC.WRITE_SINGLE_COIL: {
          const r = parseWriteSingleRequest(pdu)
          if (r.value !== 0x0000 && r.value !== 0xff00) {
            this.logException(ctx, fc, EXCEPTION.ILLEGAL_DATA_VALUE, pdu)
            return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_DATA_VALUE)
          }
          return this.echoOrExc(pdu, this.handler.writeSingleCoil(ctx, r.addr, r.value === 0xff00), ctx, pdu)
        }
        case FC.WRITE_SINGLE_REGISTER: {
          const r = parseWriteSingleRequest(pdu)
          return this.echoOrExc(pdu, this.handler.writeSingleRegister(ctx, r.addr, r.value), ctx, pdu)
        }
        case FC.WRITE_MULTIPLE_COILS: {
          const r = parseWriteMultipleCoilsRequest(pdu)
          return this.echoOrExc(
            buildWriteEchoResponse(pdu.subarray(0, 5)),
            this.handler.writeMultipleCoils(ctx, r.startAddr, r.bits),
            ctx,
            pdu
          )
        }
        case FC.WRITE_MULTIPLE_REGISTERS: {
          const r = parseWriteMultipleRegistersRequest(pdu)
          return this.echoOrExc(
            buildWriteEchoResponse(pdu.subarray(0, 5)),
            this.handler.writeMultipleRegisters(ctx, r.startAddr, r.registers),
            ctx,
            pdu
          )
        }
        case FC.MASK_WRITE_REGISTER: {
          const r = parseMaskWriteRequest(pdu)
          return this.echoOrExc(pdu, this.handler.maskWriteRegister(ctx, r.addr, r.andMask, r.orMask), ctx, pdu)
        }
        default:
          this.logException(ctx, fc, EXCEPTION.ILLEGAL_FUNCTION, pdu)
          return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_FUNCTION)
      }
    } catch (e) {
      this.log.error(
        `[${ctx.remote}] request error: unit=${ctx.unitId} ${describeRequest(pdu)} ` +
          `-> internal failure: ${(e as Error).message}`
      )
      return buildExceptionResponse(fc, EXCEPTION.SERVER_DEVICE_FAILURE)
    }
  }

  private toResponse(
    fc: number,
    result: HandlerResult,
    ctx?: RequestContext,
    req?: Buffer
  ): Buffer {
    if (result.kind === 'exception') {
      if (ctx && req) this.logException(ctx, fc, result.code, req)
      return buildExceptionResponse(fc, result.code)
    }
    if (result.kind === 'bits')
      return buildReadBitsResponse(fc as 1 | 2, result.bits)
    if (result.kind === 'registers')
      return buildReadRegistersResponse(fc as 3 | 4, result.registers)
    return buildExceptionResponse(fc, EXCEPTION.SERVER_DEVICE_FAILURE)
  }

  private echoOrExc(
    echo: Buffer,
    result: HandlerResult,
    ctx?: RequestContext,
    req?: Buffer
  ): Buffer {
    if (result.kind === 'exception') {
      const fc = echo.readUInt8(0)
      if (ctx && req) this.logException(ctx, fc, result.code, req)
      return buildExceptionResponse(fc, result.code)
    }
    return echo
  }
}
