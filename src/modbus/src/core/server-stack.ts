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
    private readonly strictUnitId: boolean
  ) {
    super()
    link.on('data', (d: Buffer) => this.onData(d))
    link.on('close', () => this.emit('close'))
  }

  private onData(chunk: Buffer): void {
    if (this.mode === 'mbap') {
      const { frames, fatal } = this.mbapDecoder.push(chunk)
      if (fatal) {
        this.link.close()
        return
      }
      for (const f of frames) {
        const resp = this.dispatch(f.unitId)
        if (resp) this.link.write(encodeMbap(f.transactionId, f.unitId, resp(f.pdu)))
      }
    } else {
      const frames = this.rtuDecoder.push(chunk)
      for (const f of frames) {
        // Broadcast (unit 0): execute, do not respond.
        const resp = this.dispatch(f.unitId)
        if (!resp) continue
        if (f.unitId === 0) {
          resp(f.pdu) // execute side effects, discard response
          continue
        }
        this.link.write(encodeRtu(f.unitId, resp(f.pdu)))
      }
    }
  }

  // Returns a function that produces the response PDU, or null to ignore the
  // frame entirely (unit id not for us in strict mode).
  private dispatch(unitId: number): ((pdu: Buffer) => Buffer) | null {
    if (unitId !== 0 && this.strictUnitId && !this.handler.acceptsUnit(unitId)) {
      return null
    }
    const ctx: RequestContext = { unitId, remote: this.link.describe() }
    return (pdu: Buffer) => this.handlePdu(ctx, pdu)
  }

  private handlePdu(ctx: RequestContext, pdu: Buffer): Buffer {
    const fc = pdu.readUInt8(0)
    try {
      switch (fc) {
        case FC.READ_COILS: {
          const r = parseReadRequest(pdu)
          if (r.quantity < 1 || r.quantity > MAX_READ_BITS)
            return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_DATA_VALUE)
          return this.toResponse(fc, this.handler.readCoils(ctx, r.startAddr, r.quantity))
        }
        case FC.READ_DISCRETE_INPUTS: {
          const r = parseReadRequest(pdu)
          if (r.quantity < 1 || r.quantity > MAX_READ_BITS)
            return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_DATA_VALUE)
          return this.toResponse(
            fc,
            this.handler.readDiscreteInputs(ctx, r.startAddr, r.quantity)
          )
        }
        case FC.READ_HOLDING_REGISTERS: {
          const r = parseReadRequest(pdu)
          if (r.quantity < 1 || r.quantity > MAX_READ_REGS)
            return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_DATA_VALUE)
          return this.toResponse(fc, this.handler.readHolding(ctx, r.startAddr, r.quantity))
        }
        case FC.READ_INPUT_REGISTERS: {
          const r = parseReadRequest(pdu)
          if (r.quantity < 1 || r.quantity > MAX_READ_REGS)
            return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_DATA_VALUE)
          return this.toResponse(fc, this.handler.readInput(ctx, r.startAddr, r.quantity))
        }
        case FC.WRITE_SINGLE_COIL: {
          const r = parseWriteSingleRequest(pdu)
          if (r.value !== 0x0000 && r.value !== 0xff00)
            return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_DATA_VALUE)
          return this.echoOrExc(pdu, this.handler.writeSingleCoil(ctx, r.addr, r.value === 0xff00))
        }
        case FC.WRITE_SINGLE_REGISTER: {
          const r = parseWriteSingleRequest(pdu)
          return this.echoOrExc(pdu, this.handler.writeSingleRegister(ctx, r.addr, r.value))
        }
        case FC.WRITE_MULTIPLE_COILS: {
          const r = parseWriteMultipleCoilsRequest(pdu)
          return this.echoOrExc(
            buildWriteEchoResponse(pdu.subarray(0, 5)),
            this.handler.writeMultipleCoils(ctx, r.startAddr, r.bits)
          )
        }
        case FC.WRITE_MULTIPLE_REGISTERS: {
          const r = parseWriteMultipleRegistersRequest(pdu)
          return this.echoOrExc(
            buildWriteEchoResponse(pdu.subarray(0, 5)),
            this.handler.writeMultipleRegisters(ctx, r.startAddr, r.registers)
          )
        }
        case FC.MASK_WRITE_REGISTER: {
          const r = parseMaskWriteRequest(pdu)
          return this.echoOrExc(pdu, this.handler.maskWriteRegister(ctx, r.addr, r.andMask, r.orMask))
        }
        default:
          return buildExceptionResponse(fc, EXCEPTION.ILLEGAL_FUNCTION)
      }
    } catch {
      return buildExceptionResponse(fc, EXCEPTION.SERVER_DEVICE_FAILURE)
    }
  }

  private toResponse(fc: number, result: HandlerResult): Buffer {
    if (result.kind === 'exception') return buildExceptionResponse(fc, result.code)
    if (result.kind === 'bits')
      return buildReadBitsResponse(fc as 1 | 2, result.bits)
    if (result.kind === 'registers')
      return buildReadRegistersResponse(fc as 3 | 4, result.registers)
    return buildExceptionResponse(fc, EXCEPTION.SERVER_DEVICE_FAILURE)
  }

  private echoOrExc(echo: Buffer, result: HandlerResult): Buffer {
    if (result.kind === 'exception') {
      const fc = echo.readUInt8(0)
      return buildExceptionResponse(fc, result.code)
    }
    return echo
  }
}
