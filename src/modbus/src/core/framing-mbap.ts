/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// MBAP (Modbus Application Protocol) framing for Modbus TCP / TCP-over-TLS.
// Header layout (7 bytes): transactionId(2) protocolId(2)=0 length(2) unitId(1),
// followed by the PDU. `length` counts unitId + PDU.

export const MBAP_HEADER_LEN = 7
export const MAX_ADU_LEN = 260 // 7 header + 253 PDU

export interface MbapFrame {
  transactionId: number
  unitId: number
  pdu: Buffer
}

export function encodeMbap(
  transactionId: number,
  unitId: number,
  pdu: Buffer
): Buffer {
  const buf = Buffer.allocUnsafe(MBAP_HEADER_LEN + pdu.length)
  buf.writeUInt16BE(transactionId & 0xffff, 0)
  buf.writeUInt16BE(0, 2) // protocol id
  buf.writeUInt16BE(pdu.length + 1, 4) // length = unitId + pdu
  buf.writeUInt8(unitId & 0xff, 6)
  pdu.copy(buf, MBAP_HEADER_LEN)
  return buf
}

// Incremental MBAP frame decoder driven by a TCP byte stream. Emits complete
// frames and reports fatal desynchronization (caller should drop the link).
export class MbapDecoder {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): { frames: MbapFrame[]; fatal: boolean } {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const frames: MbapFrame[] = []

    while (this.buf.length >= MBAP_HEADER_LEN) {
      const protocolId = this.buf.readUInt16BE(2)
      const length = this.buf.readUInt16BE(4)
      // Sanity: protocolId must be 0, length within [2, 254] (unitId + PDU).
      if (protocolId !== 0 || length < 2 || length > MAX_ADU_LEN - 6) {
        return { frames, fatal: true }
      }
      const total = MBAP_HEADER_LEN - 1 + length // header(6) + (unitId+pdu)
      if (this.buf.length < total) break // wait for more

      const transactionId = this.buf.readUInt16BE(0)
      const unitId = this.buf.readUInt8(6)
      const pdu = this.buf.subarray(MBAP_HEADER_LEN, total)
      frames.push({ transactionId, unitId, pdu: Buffer.from(pdu) })
      this.buf = this.buf.subarray(total)
    }
    return { frames, fatal: false }
  }

  reset(): void {
    this.buf = Buffer.alloc(0)
  }
}

// Transaction-id allocator (wraps at 16 bits, skips 0 which some stacks reserve).
export class TransactionIdGenerator {
  private next = 1
  allocate(): number {
    const id = this.next
    this.next = (this.next + 1) & 0xffff
    if (this.next === 0) this.next = 1
    return id
  }
}
