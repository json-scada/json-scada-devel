import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crc16, appendCrc16, checkCrc16 } from '../../src/core/crc16.js'

test('crc16 known vector: 01 03 00 00 00 0A', () => {
  // Classic modbus example; CRC low-high = C5 CD.
  const buf = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a])
  const crc = crc16(buf)
  assert.equal(crc & 0xff, 0xc5) // low byte
  assert.equal((crc >> 8) & 0xff, 0xcd) // high byte
})

test('crc16 known vector: 11 03 006B 0003', () => {
  const buf = Buffer.from([0x11, 0x03, 0x00, 0x6b, 0x00, 0x03])
  const crc = crc16(buf)
  // Expected CRC bytes 76 87 (low, high) per Modbus spec appendix.
  assert.equal(crc & 0xff, 0x76)
  assert.equal((crc >> 8) & 0xff, 0x87)
})

test('appendCrc16 + checkCrc16 round-trip', () => {
  const body = Buffer.from([0x01, 0x03, 0x02, 0x00, 0x0a])
  const framed = appendCrc16(body)
  assert.equal(framed.length, body.length + 2)
  assert.ok(checkCrc16(framed))
  // corrupt a byte
  framed[2] = framed[2]! ^ 0xff
  assert.ok(!checkCrc16(framed))
})
