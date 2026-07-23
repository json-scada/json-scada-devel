/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Modbus Protocol Data Unit (PDU) builders and parsers. A PDU is the function
// code plus its data, independent of transport framing (MBAP or RTU).

export const FC = {
  READ_COILS: 1,
  READ_DISCRETE_INPUTS: 2,
  READ_HOLDING_REGISTERS: 3,
  READ_INPUT_REGISTERS: 4,
  WRITE_SINGLE_COIL: 5,
  WRITE_SINGLE_REGISTER: 6,
  WRITE_MULTIPLE_COILS: 15,
  WRITE_MULTIPLE_REGISTERS: 16,
  MASK_WRITE_REGISTER: 22,
  READ_WRITE_MULTIPLE_REGISTERS: 23,
} as const

export const EXCEPTION = {
  ILLEGAL_FUNCTION: 0x01,
  ILLEGAL_DATA_ADDRESS: 0x02,
  ILLEGAL_DATA_VALUE: 0x03,
  SERVER_DEVICE_FAILURE: 0x04,
  ACKNOWLEDGE: 0x05,
  SERVER_DEVICE_BUSY: 0x06,
  GATEWAY_PATH_UNAVAILABLE: 0x0a,
  GATEWAY_TARGET_NO_RESPONSE: 0x0b,
} as const

export const EXCEPTION_NAMES: Record<number, string> = {
  0x01: 'ILLEGAL FUNCTION',
  0x02: 'ILLEGAL DATA ADDRESS',
  0x03: 'ILLEGAL DATA VALUE',
  0x04: 'SERVER DEVICE FAILURE',
  0x05: 'ACKNOWLEDGE',
  0x06: 'SERVER DEVICE BUSY',
  0x08: 'MEMORY PARITY ERROR',
  0x0a: 'GATEWAY PATH UNAVAILABLE',
  0x0b: 'GATEWAY TARGET DEVICE FAILED TO RESPOND',
}

export class ModbusExceptionError extends Error {
  constructor(
    readonly functionCode: number,
    readonly exceptionCode: number
  ) {
    super(
      `Modbus exception ${exceptionCode.toString(16).padStart(2, '0')} ${
        EXCEPTION_NAMES[exceptionCode] ?? 'UNKNOWN'
      } (FC ${functionCode})`
    )
    this.name = 'ModbusExceptionError'
  }
}

// ----- Request builders (client side) -----

export function buildReadRequest(
  fc: 1 | 2 | 3 | 4,
  startAddr: number,
  quantity: number
): Buffer {
  const pdu = Buffer.allocUnsafe(5)
  pdu.writeUInt8(fc, 0)
  pdu.writeUInt16BE(startAddr, 1)
  pdu.writeUInt16BE(quantity, 3)
  return pdu
}

export function buildWriteSingleCoil(addr: number, on: boolean): Buffer {
  const pdu = Buffer.allocUnsafe(5)
  pdu.writeUInt8(FC.WRITE_SINGLE_COIL, 0)
  pdu.writeUInt16BE(addr, 1)
  pdu.writeUInt16BE(on ? 0xff00 : 0x0000, 3)
  return pdu
}

export function buildWriteSingleRegister(addr: number, value: number): Buffer {
  const pdu = Buffer.allocUnsafe(5)
  pdu.writeUInt8(FC.WRITE_SINGLE_REGISTER, 0)
  pdu.writeUInt16BE(addr, 1)
  pdu.writeUInt16BE(value & 0xffff, 3)
  return pdu
}

export function buildWriteMultipleCoils(
  startAddr: number,
  bits: boolean[]
): Buffer {
  const byteCount = Math.ceil(bits.length / 8)
  const pdu = Buffer.alloc(6 + byteCount)
  pdu.writeUInt8(FC.WRITE_MULTIPLE_COILS, 0)
  pdu.writeUInt16BE(startAddr, 1)
  pdu.writeUInt16BE(bits.length, 3)
  pdu.writeUInt8(byteCount, 5)
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) pdu[6 + (i >> 3)]! |= 1 << (i & 7)
  }
  return pdu
}

export function buildWriteMultipleRegisters(
  startAddr: number,
  registers: Buffer // big-endian wire bytes, length = 2 * count
): Buffer {
  const count = registers.length / 2
  const pdu = Buffer.allocUnsafe(6 + registers.length)
  pdu.writeUInt8(FC.WRITE_MULTIPLE_REGISTERS, 0)
  pdu.writeUInt16BE(startAddr, 1)
  pdu.writeUInt16BE(count, 3)
  pdu.writeUInt8(registers.length, 5)
  registers.copy(pdu, 6)
  return pdu
}

export function buildMaskWriteRegister(
  addr: number,
  andMask: number,
  orMask: number
): Buffer {
  const pdu = Buffer.allocUnsafe(7)
  pdu.writeUInt8(FC.MASK_WRITE_REGISTER, 0)
  pdu.writeUInt16BE(addr, 1)
  pdu.writeUInt16BE(andMask & 0xffff, 3)
  pdu.writeUInt16BE(orMask & 0xffff, 5)
  return pdu
}

// ----- Response parsing (client side) -----

// Throws ModbusExceptionError if the PDU is an exception response.
function checkException(pdu: Buffer): void {
  const fc = pdu.readUInt8(0)
  if (fc & 0x80) {
    const code = pdu.length > 1 ? pdu.readUInt8(1) : 0
    throw new ModbusExceptionError(fc & 0x7f, code)
  }
}

// Parse a read-bits response (FC1/FC2) into an array of booleans of `quantity`.
export function parseReadBitsResponse(pdu: Buffer, quantity: number): boolean[] {
  checkException(pdu)
  const byteCount = pdu.readUInt8(1)
  if (pdu.length < 2 + byteCount)
    throw new Error('Truncated read-bits response')
  const bits: boolean[] = []
  for (let i = 0; i < quantity; i++) {
    const byte = pdu.readUInt8(2 + (i >> 3))
    bits.push(((byte >> (i & 7)) & 1) === 1)
  }
  return bits
}

// Parse a read-registers response (FC3/FC4) into the raw big-endian register buffer.
export function parseReadRegistersResponse(
  pdu: Buffer,
  quantity: number
): Buffer {
  checkException(pdu)
  const byteCount = pdu.readUInt8(1)
  if (byteCount !== quantity * 2)
    throw new Error(
      `Register byte count mismatch: got ${byteCount}, expected ${quantity * 2}`
    )
  if (pdu.length < 2 + byteCount)
    throw new Error('Truncated read-registers response')
  return pdu.subarray(2, 2 + byteCount)
}

// Validate a write response echo (FC5/6/15/16/22). Throws on exception/mismatch.
export function parseWriteResponse(pdu: Buffer): void {
  checkException(pdu)
  // Echo contents already imply success; nothing further required.
}

// Expected number of registers/bits in a read response, for RTU length prediction.
export function expectedReadByteCount(pdu: Buffer): number {
  // For responses, byte count is the second byte.
  return pdu.readUInt8(1)
}

// ----- Request parsing (server side) -----

export interface ReadRequest {
  fc: number
  startAddr: number
  quantity: number
}

export function parseReadRequest(pdu: Buffer): ReadRequest {
  return {
    fc: pdu.readUInt8(0),
    startAddr: pdu.readUInt16BE(1),
    quantity: pdu.readUInt16BE(3),
  }
}

export interface WriteSingleRequest {
  fc: number
  addr: number
  value: number // coil: 0xFF00/0; register: 16-bit
}

export function parseWriteSingleRequest(pdu: Buffer): WriteSingleRequest {
  return {
    fc: pdu.readUInt8(0),
    addr: pdu.readUInt16BE(1),
    value: pdu.readUInt16BE(3),
  }
}

export interface WriteMultipleCoilsRequest {
  startAddr: number
  quantity: number
  bits: boolean[]
}

export function parseWriteMultipleCoilsRequest(
  pdu: Buffer
): WriteMultipleCoilsRequest {
  const startAddr = pdu.readUInt16BE(1)
  const quantity = pdu.readUInt16BE(3)
  const byteCount = pdu.readUInt8(5)
  const bits: boolean[] = []
  for (let i = 0; i < quantity; i++) {
    const byte = pdu.readUInt8(6 + (i >> 3))
    bits.push(((byte >> (i & 7)) & 1) === 1)
  }
  void byteCount
  return { startAddr, quantity, bits }
}

export interface WriteMultipleRegistersRequest {
  startAddr: number
  quantity: number
  registers: Buffer // raw big-endian wire bytes
}

export function parseWriteMultipleRegistersRequest(
  pdu: Buffer
): WriteMultipleRegistersRequest {
  const startAddr = pdu.readUInt16BE(1)
  const quantity = pdu.readUInt16BE(3)
  const byteCount = pdu.readUInt8(5)
  return {
    startAddr,
    quantity,
    registers: pdu.subarray(6, 6 + byteCount),
  }
}

export interface MaskWriteRequest {
  addr: number
  andMask: number
  orMask: number
}

export function parseMaskWriteRequest(pdu: Buffer): MaskWriteRequest {
  return {
    addr: pdu.readUInt16BE(1),
    andMask: pdu.readUInt16BE(3),
    orMask: pdu.readUInt16BE(5),
  }
}

// ----- Response builders (server side) -----

export function buildExceptionResponse(fc: number, code: number): Buffer {
  const pdu = Buffer.allocUnsafe(2)
  pdu.writeUInt8((fc & 0x7f) | 0x80, 0)
  pdu.writeUInt8(code, 1)
  return pdu
}

export function buildReadBitsResponse(fc: 1 | 2, bits: boolean[]): Buffer {
  const byteCount = Math.ceil(bits.length / 8)
  const pdu = Buffer.alloc(2 + byteCount)
  pdu.writeUInt8(fc, 0)
  pdu.writeUInt8(byteCount, 1)
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) pdu[2 + (i >> 3)]! |= 1 << (i & 7)
  }
  return pdu
}

export function buildReadRegistersResponse(
  fc: 3 | 4,
  registers: Buffer
): Buffer {
  const pdu = Buffer.allocUnsafe(2 + registers.length)
  pdu.writeUInt8(fc, 0)
  pdu.writeUInt8(registers.length, 1)
  registers.copy(pdu, 2)
  return pdu
}

// Write responses simply echo the first 5 (or 7 for mask) bytes of the request.
export function buildWriteEchoResponse(requestPdu: Buffer): Buffer {
  return Buffer.from(requestPdu)
}

// Predict total RTU response frame length (unitId + PDU + CRC) for a given
// request PDU, so the RTU framer knows when a complete response has arrived.
// Returns null when the length is not predictable (unknown FC).
export function predictResponseLength(requestPdu: Buffer): number | null {
  const fc = requestPdu.readUInt8(0)
  switch (fc) {
    case FC.READ_COILS:
    case FC.READ_DISCRETE_INPUTS: {
      const qty = requestPdu.readUInt16BE(3)
      return 1 + 2 + Math.ceil(qty / 8) + 2 // unit + fc + bytecount + data + crc
    }
    case FC.READ_HOLDING_REGISTERS:
    case FC.READ_INPUT_REGISTERS: {
      const qty = requestPdu.readUInt16BE(3)
      return 1 + 2 + qty * 2 + 2
    }
    case FC.WRITE_SINGLE_COIL:
    case FC.WRITE_SINGLE_REGISTER:
    case FC.WRITE_MULTIPLE_COILS:
    case FC.WRITE_MULTIPLE_REGISTERS:
      return 1 + 5 + 2 // unit + (fc+addr+qty/value) + crc
    case FC.MASK_WRITE_REGISTER:
      return 1 + 7 + 2
    default:
      return null
  }
}
