/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Logging hooks for the protocol core. The core stays free of JSON-SCADA
// concerns: the drivers inject an adapter that forwards to the shared logger at
// the appropriate level. `debug` is only ever called for logLevel 3 traces, so
// callers should guard expensive formatting with `logger.debugEnabled`.

import { EXCEPTION_NAMES, FC } from './pdu.js'

export interface StackLogger {
  // true when logLevel >= 3; lets callers skip building trace strings
  readonly debugEnabled: boolean
  debug(msg: string): void
  info(msg: string): void
  error(msg: string): void
}

export const NoopLogger: StackLogger = {
  debugEnabled: false,
  debug() {},
  info() {},
  error() {},
}

// Space-separated uppercase hex dump, truncated so a runaway frame cannot flood
// the log. Modbus ADUs are <= 260 bytes, so the cap is only a safety net.
export function hex(buf: Buffer, max = 300): string {
  const n = Math.min(buf.length, max)
  const parts: string[] = []
  for (let i = 0; i < n; i++) parts.push(buf[i]!.toString(16).padStart(2, '0').toUpperCase())
  let s = parts.join(' ')
  if (buf.length > max) s += ` ... (+${buf.length - max} bytes)`
  return s
}

const FC_NAMES: Record<number, string> = {
  [FC.READ_COILS]: 'READ_COILS',
  [FC.READ_DISCRETE_INPUTS]: 'READ_DISCRETE_INPUTS',
  [FC.READ_HOLDING_REGISTERS]: 'READ_HOLDING_REGISTERS',
  [FC.READ_INPUT_REGISTERS]: 'READ_INPUT_REGISTERS',
  [FC.WRITE_SINGLE_COIL]: 'WRITE_SINGLE_COIL',
  [FC.WRITE_SINGLE_REGISTER]: 'WRITE_SINGLE_REGISTER',
  [FC.WRITE_MULTIPLE_COILS]: 'WRITE_MULTIPLE_COILS',
  [FC.WRITE_MULTIPLE_REGISTERS]: 'WRITE_MULTIPLE_REGISTERS',
  [FC.MASK_WRITE_REGISTER]: 'MASK_WRITE_REGISTER',
  [FC.READ_WRITE_MULTIPLE_REGISTERS]: 'READ_WRITE_MULTIPLE_REGISTERS',
}

export function fcName(fc: number): string {
  const base = fc & 0x7f
  const name = FC_NAMES[base] ?? 'FC' + base
  return (fc & 0x80) !== 0 ? name + '(exception)' : name
}

// One-line human summary of a request PDU, e.g.
//   "fc=3 READ_HOLDING_REGISTERS addr=10 qty=2"
export function describeRequest(pdu: Buffer): string {
  if (pdu.length < 1) return 'empty pdu'
  const fc = pdu.readUInt8(0)
  const head = `fc=${fc} ${fcName(fc)}`
  try {
    switch (fc) {
      case FC.READ_COILS:
      case FC.READ_DISCRETE_INPUTS:
      case FC.READ_HOLDING_REGISTERS:
      case FC.READ_INPUT_REGISTERS:
        return `${head} addr=${pdu.readUInt16BE(1)} qty=${pdu.readUInt16BE(3)}`
      case FC.WRITE_SINGLE_COIL:
        return `${head} addr=${pdu.readUInt16BE(1)} value=${
          pdu.readUInt16BE(3) === 0xff00 ? 'ON' : 'OFF'
        }`
      case FC.WRITE_SINGLE_REGISTER:
        return `${head} addr=${pdu.readUInt16BE(1)} value=${pdu.readUInt16BE(3)}`
      case FC.WRITE_MULTIPLE_COILS:
      case FC.WRITE_MULTIPLE_REGISTERS:
        return `${head} addr=${pdu.readUInt16BE(1)} qty=${pdu.readUInt16BE(
          3
        )} bytes=${pdu.readUInt8(5)}`
      case FC.MASK_WRITE_REGISTER:
        return `${head} addr=${pdu.readUInt16BE(1)} and=0x${pdu
          .readUInt16BE(3)
          .toString(16)} or=0x${pdu.readUInt16BE(5).toString(16)}`
      default:
        return head
    }
  } catch {
    return head + ' (truncated)'
  }
}

// One-line human summary of a response PDU.
export function describeResponse(pdu: Buffer): string {
  if (pdu.length < 1) return 'empty pdu'
  const fc = pdu.readUInt8(0)
  if ((fc & 0x80) !== 0) {
    const code = pdu.length > 1 ? pdu.readUInt8(1) : 0
    return `fc=${fc & 0x7f} ${fcName(fc)} code=0x${code
      .toString(16)
      .padStart(2, '0')} ${EXCEPTION_NAMES[code] ?? 'UNKNOWN'}`
  }
  const head = `fc=${fc} ${fcName(fc)}`
  try {
    switch (fc) {
      case FC.READ_COILS:
      case FC.READ_DISCRETE_INPUTS:
      case FC.READ_HOLDING_REGISTERS:
      case FC.READ_INPUT_REGISTERS:
        return `${head} bytes=${pdu.readUInt8(1)}`
      case FC.WRITE_SINGLE_COIL:
      case FC.WRITE_SINGLE_REGISTER:
      case FC.WRITE_MULTIPLE_COILS:
      case FC.WRITE_MULTIPLE_REGISTERS:
        return `${head} addr=${pdu.readUInt16BE(1)} echo=${pdu.readUInt16BE(3)}`
      default:
        return head
    }
  } catch {
    return head + ' (truncated)'
  }
}

export function exceptionName(code: number): string {
  return `0x${code.toString(16).padStart(2, '0')} ${
    EXCEPTION_NAMES[code] ?? 'UNKNOWN'
  }`
}
