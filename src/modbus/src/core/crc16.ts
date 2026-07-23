/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Modbus CRC-16 (polynomial 0xA001, reflected). Table-driven for speed.
// The CRC is appended low byte first (little-endian) to RTU frames.

const CRC_TABLE = new Uint16Array(256)
for (let i = 0; i < 256; i++) {
  let crc = i
  for (let j = 0; j < 8; j++) {
    crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1
  }
  CRC_TABLE[i] = crc
}

// Compute the Modbus CRC-16 over a buffer slice [start, end).
export function crc16(buf: Buffer, start = 0, end = buf.length): number {
  let crc = 0xffff
  for (let i = start; i < end; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]!) & 0xff]!
  }
  return crc & 0xffff
}

// Append the CRC-16 of the whole buffer as two trailing bytes (low, high).
export function appendCrc16(buf: Buffer): Buffer {
  const crc = crc16(buf)
  const out = Buffer.allocUnsafe(buf.length + 2)
  buf.copy(out, 0)
  out.writeUInt16LE(crc, buf.length)
  return out
}

// Verify the trailing two bytes of a frame match the CRC of the preceding bytes.
export function checkCrc16(frame: Buffer): boolean {
  if (frame.length < 3) return false
  const expected = crc16(frame, 0, frame.length - 2)
  const actual = frame.readUInt16LE(frame.length - 2)
  return expected === actual
}
