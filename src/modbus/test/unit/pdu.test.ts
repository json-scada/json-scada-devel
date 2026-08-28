import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReadRequest,
  buildWriteSingleCoil,
  buildWriteMultipleRegisters,
  parseReadBitsResponse,
  parseReadRegistersResponse,
  parseWriteResponse,
  parseReadRequest,
  parseWriteMultipleRegistersRequest,
  buildReadRegistersResponse,
  buildExceptionResponse,
  ModbusExceptionError,
  predictResponseLength,
  FC,
} from '../../src/core/pdu.js'

test('buildReadRequest FC3', () => {
  const pdu = buildReadRequest(3, 0x006b, 3)
  assert.deepEqual([...pdu], [0x03, 0x00, 0x6b, 0x00, 0x03])
})

test('buildWriteSingleCoil on/off', () => {
  assert.deepEqual([...buildWriteSingleCoil(10, true)], [0x05, 0x00, 0x0a, 0xff, 0x00])
  assert.deepEqual([...buildWriteSingleCoil(10, false)], [0x05, 0x00, 0x0a, 0x00, 0x00])
})

test('parseReadRegistersResponse extracts registers', () => {
  // FC3, byteCount=4, two registers 0x0001 0x0002
  const pdu = Buffer.from([0x03, 0x04, 0x00, 0x01, 0x00, 0x02])
  const regs = parseReadRegistersResponse(pdu, 2)
  assert.deepEqual([...regs], [0x00, 0x01, 0x00, 0x02])
})

test('parseReadBitsResponse', () => {
  // FC1, byteCount=1, bits 0b00000101 => coils 0 and 2 on
  const pdu = Buffer.from([0x01, 0x01, 0x05])
  const bits = parseReadBitsResponse(pdu, 3)
  assert.deepEqual(bits, [true, false, true])
})

test('exception response throws typed error', () => {
  const pdu = Buffer.from([0x83, 0x02]) // FC3 exception, illegal data address
  assert.throws(
    () => parseReadRegistersResponse(pdu, 1),
    (e: unknown) => {
      assert.ok(e instanceof ModbusExceptionError)
      assert.equal(e.exceptionCode, 0x02)
      assert.equal(e.functionCode, 0x03)
      return true
    }
  )
})

test('write multiple registers round-trip request parse', () => {
  const regs = Buffer.from([0x00, 0x0a, 0x01, 0x02])
  const pdu = buildWriteMultipleRegisters(0x0010, regs)
  const parsed = parseWriteMultipleRegistersRequest(pdu)
  assert.equal(parsed.startAddr, 0x10)
  assert.equal(parsed.quantity, 2)
  assert.deepEqual([...parsed.registers], [0x00, 0x0a, 0x01, 0x02])
})

test('parseReadRequest server side', () => {
  const pdu = buildReadRequest(3, 100, 10)
  const r = parseReadRequest(pdu)
  assert.equal(r.fc, FC.READ_HOLDING_REGISTERS)
  assert.equal(r.startAddr, 100)
  assert.equal(r.quantity, 10)
})

test('server builds read response and client parses it', () => {
  const regs = Buffer.from([0x12, 0x34, 0x56, 0x78])
  const resp = buildReadRegistersResponse(3, regs)
  const back = parseReadRegistersResponse(resp, 2)
  assert.deepEqual([...back], [...regs])
})

test('write echo response validates', () => {
  const echo = buildWriteSingleCoil(5, true)
  assert.doesNotThrow(() => parseWriteResponse(echo))
})

test('exception response builder', () => {
  const e = buildExceptionResponse(3, 2)
  assert.deepEqual([...e], [0x83, 0x02])
})

test('predictResponseLength', () => {
  assert.equal(predictResponseLength(buildReadRequest(3, 0, 10)), 1 + 2 + 20 + 2)
  assert.equal(predictResponseLength(buildReadRequest(1, 0, 16)), 1 + 2 + 2 + 2)
  assert.equal(predictResponseLength(buildWriteSingleCoil(0, true)), 1 + 5 + 2)
})
