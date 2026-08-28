/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// RTU framing for serial and RTU-encapsulated-in-TCP transports. An RTU ADU is
// unitId(1) + PDU + CRC16(2). Node.js cannot honor the 3.5-char inter-frame
// silence precisely, so the framers use length-prediction where possible and an
// idle-gap timeout as the fallback delimiter and resynchronization point.

import { appendCrc16, checkCrc16 } from './crc16.js'
import {
  FC,
  predictResponseLength,
  EXCEPTION_NAMES,
} from './pdu.js'

export function encodeRtu(unitId: number, pdu: Buffer): Buffer {
  const body = Buffer.allocUnsafe(1 + pdu.length)
  body.writeUInt8(unitId & 0xff, 0)
  pdu.copy(body, 1)
  return appendCrc16(body)
}

export interface RtuFrame {
  unitId: number
  pdu: Buffer
}

// Client-side RTU response decoder. Because RTU has no length field, the decoder
// is told the expected response length for the outstanding request (derived from
// the request PDU). It completes a frame when either the predicted length is
// reached with a valid CRC, or an exception response (5 bytes) is seen, or the
// idle timeout fires.
export class RtuResponseDecoder {
  private buf: Buffer = Buffer.alloc(0)
  private expectedLen: number | null = null

  // Call when a new request is sent, to arm length prediction.
  expectResponseTo(requestPdu: Buffer): void {
    this.expectedLen = predictResponseLength(requestPdu)
    this.buf = Buffer.alloc(0)
  }

  reset(): void {
    this.buf = Buffer.alloc(0)
    this.expectedLen = null
  }

  push(chunk: Buffer): RtuFrame | null {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    return this.tryComplete()
  }

  // Called when the idle-gap timer fires: treat whatever is buffered as a frame.
  onIdle(): RtuFrame | null {
    return this.tryComplete(true)
  }

  private tryComplete(idle = false): RtuFrame | null {
    if (this.buf.length < 3) return null

    // Exception response: unitId + (fc|0x80) + code + CRC = 5 bytes.
    if (this.buf.length >= 2 && (this.buf[1]! & 0x80) !== 0) {
      if (this.buf.length >= 5) {
        const frame = this.buf.subarray(0, 5)
        if (checkCrc16(frame)) {
          const out = { unitId: frame[0]!, pdu: Buffer.from(frame.subarray(1, 3)) }
          this.buf = this.buf.subarray(5)
          this.expectedLen = null
          return out
        }
      }
      return null
    }

    if (this.expectedLen !== null && this.buf.length >= this.expectedLen) {
      const frame = this.buf.subarray(0, this.expectedLen)
      if (checkCrc16(frame)) {
        const out = {
          unitId: frame[0]!,
          pdu: Buffer.from(frame.subarray(1, this.expectedLen - 2)),
        }
        this.buf = this.buf.subarray(this.expectedLen)
        this.expectedLen = null
        return out
      }
      // CRC mismatch at predicted length: drop to resync on idle.
      if (idle) this.buf = Buffer.alloc(0)
      return null
    }

    if (idle) {
      // Fallback: accept if CRC of the whole buffer checks out.
      if (checkCrc16(this.buf)) {
        const out = {
          unitId: this.buf[0]!,
          pdu: Buffer.from(this.buf.subarray(1, this.buf.length - 2)),
        }
        this.buf = Buffer.alloc(0)
        this.expectedLen = null
        return out
      }
      this.buf = Buffer.alloc(0)
    }
    return null
  }
}

// Server-side RTU request decoder. Request length is predictable from the FC and
// its fixed/counted fields, so no external hint is needed.
export class RtuRequestDecoder {
  private buf: Buffer = Buffer.alloc(0)

  reset(): void {
    this.buf = Buffer.alloc(0)
  }

  push(chunk: Buffer): RtuFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out: RtuFrame[] = []
    // Keep consuming complete requests.
    for (;;) {
      const consumed = this.tryOne(out)
      if (!consumed) break
    }
    return out
  }

  onIdle(): RtuFrame[] {
    const out: RtuFrame[] = []
    if (this.buf.length >= 4 && checkCrc16(this.buf)) {
      out.push({
        unitId: this.buf[0]!,
        pdu: Buffer.from(this.buf.subarray(1, this.buf.length - 2)),
      })
    }
    this.buf = Buffer.alloc(0)
    return out
  }

  private tryOne(out: RtuFrame[]): boolean {
    const len = this.predictRequestLength(this.buf)
    if (len === null) return false
    if (this.buf.length < len) return false
    const frame = this.buf.subarray(0, len)
    if (checkCrc16(frame)) {
      out.push({
        unitId: frame[0]!,
        pdu: Buffer.from(frame.subarray(1, len - 2)),
      })
      this.buf = this.buf.subarray(len)
      return true
    }
    // CRC failure: shift one byte and retry to resynchronize.
    this.buf = this.buf.subarray(1)
    return this.buf.length >= 4
  }

  // Total RTU request frame length (unit + pdu + crc) or null if not yet known.
  private predictRequestLength(buf: Buffer): number | null {
    if (buf.length < 2) return null
    const fc = buf[1]!
    switch (fc) {
      case FC.READ_COILS:
      case FC.READ_DISCRETE_INPUTS:
      case FC.READ_HOLDING_REGISTERS:
      case FC.READ_INPUT_REGISTERS:
      case FC.WRITE_SINGLE_COIL:
      case FC.WRITE_SINGLE_REGISTER:
        return 1 + 5 + 2 // unit + fc + addr + qty/value + crc
      case FC.MASK_WRITE_REGISTER:
        return 1 + 7 + 2
      case FC.WRITE_MULTIPLE_COILS:
      case FC.WRITE_MULTIPLE_REGISTERS: {
        if (buf.length < 7) return null
        const byteCount = buf[6]!
        return 1 + 6 + byteCount + 2 // unit + fc+addr+qty+bytecount + data + crc
      }
      default:
        return null
    }
  }
}

export { EXCEPTION_NAMES }
