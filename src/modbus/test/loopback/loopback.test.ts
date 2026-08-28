import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { ClientStack, type FramingMode } from '../../src/core/client-stack.js'
import { TcpClientTransport } from '../../src/core/transport-tcp.js'
import {
  ServerStackLink,
  type RequestHandler,
  type RequestContext,
  type HandlerResult,
  type ServerLink,
} from '../../src/core/server-stack.js'
import { EventEmitter } from 'node:events'
import {
  buildReadRequest,
  buildWriteSingleRegister,
  buildWriteMultipleRegisters,
  parseReadRegistersResponse,
  parseWriteResponse,
  ModbusExceptionError,
  EXCEPTION,
} from '../../src/core/pdu.js'
import { parseByteOrder, encodeValue, decodeValue } from '../../src/core/datacodec.js'

// A trivial in-memory holding-register bank as the server handler.
class MemHandler implements RequestHandler {
  hr = new Map<number, number>()
  acceptsUnit(): boolean {
    return true
  }
  private badAddr(): HandlerResult {
    return { kind: 'exception', code: EXCEPTION.ILLEGAL_DATA_ADDRESS }
  }
  readCoils(): HandlerResult {
    return this.badAddr()
  }
  readDiscreteInputs(): HandlerResult {
    return this.badAddr()
  }
  readHolding(_ctx: RequestContext, start: number, qty: number): HandlerResult {
    const buf = Buffer.alloc(qty * 2)
    for (let i = 0; i < qty; i++) buf.writeUInt16BE(this.hr.get(start + i) ?? 0, i * 2)
    return { kind: 'registers', registers: buf }
  }
  readInput(): HandlerResult {
    return this.badAddr()
  }
  writeSingleCoil(): HandlerResult {
    return { kind: 'exception', code: EXCEPTION.ILLEGAL_FUNCTION }
  }
  writeSingleRegister(_ctx: RequestContext, addr: number, value: number): HandlerResult {
    this.hr.set(addr, value & 0xffff)
    return { kind: 'echo' }
  }
  writeMultipleCoils(): HandlerResult {
    return { kind: 'exception', code: EXCEPTION.ILLEGAL_FUNCTION }
  }
  writeMultipleRegisters(
    _ctx: RequestContext,
    start: number,
    registers: Buffer
  ): HandlerResult {
    for (let i = 0; i < registers.length / 2; i++)
      this.hr.set(start + i, registers.readUInt16BE(i * 2))
    return { kind: 'echo' }
  }
  maskWriteRegister(): HandlerResult {
    return { kind: 'exception', code: EXCEPTION.ILLEGAL_FUNCTION }
  }
}

class SocketServerLink extends EventEmitter implements ServerLink {
  constructor(private socket: net.Socket) {
    super()
    socket.on('data', (d) => this.emit('data', d))
    socket.on('close', () => this.emit('close'))
    socket.on('error', () => this.emit('close'))
  }
  write(data: Buffer): void {
    this.socket.write(data)
  }
  close(): void {
    this.socket.destroy()
  }
  describe(): string {
    return 'test'
  }
}

async function setup(framing: FramingMode): Promise<{
  client: ClientStack
  handler: MemHandler
  close: () => void
}> {
  const handler = new MemHandler()
  const server = net.createServer((socket) => {
    new ServerStackLink(new SocketServerLink(socket), framing, handler, false)
  })
  server.listen(0)
  await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port

  const transport = new TcpClientTransport({
    host: '127.0.0.1',
    port,
    connectTimeoutMs: 2000,
  })
  const client = new ClientStack(
    transport,
    framing,
    {
      responseTimeoutMs: 1000,
      maxRetries: 1,
      interRequestDelayMs: 0,
      interFrameDelayMs: 5,
    },
    5
  )
  await transport.connect()
  return {
    client,
    handler,
    close: () => {
      transport.close()
      server.close()
    },
  }
}

for (const framing of ['mbap', 'rtu'] as FramingMode[]) {
  test(`[${framing}] read holding registers`, async () => {
    const { client, handler, close } = await setup(framing)
    try {
      handler.hr.set(10, 0x1234)
      handler.hr.set(11, 0x5678)
      const resp = await client.request(1, buildReadRequest(3, 10, 2))
      const regs = parseReadRegistersResponse(resp, 2)
      assert.deepEqual([...regs], [0x12, 0x34, 0x56, 0x78])
    } finally {
      close()
    }
  })

  test(`[${framing}] write single register then read back`, async () => {
    const { client, handler, close } = await setup(framing)
    try {
      const w = await client.request(1, buildWriteSingleRegister(20, 0xabcd))
      parseWriteResponse(w)
      assert.equal(handler.hr.get(20), 0xabcd)
    } finally {
      close()
    }
  })

  test(`[${framing}] float32 CDAB round-trip through the wire`, async () => {
    const { client, handler, close } = await setup(framing)
    try {
      const perm = parseByteOrder('CDAB', 4)
      const wire = encodeValue('float32', 3.14159, perm)
      // write two registers
      await client.request(1, buildWriteMultipleRegisters(30, wire))
      // read them back and decode
      const resp = await client.request(1, buildReadRequest(3, 30, 2))
      const regs = parseReadRegistersResponse(resp, 2)
      const dec = decodeValue('float32', regs, 0, perm)
      assert.ok(Math.abs(Number(dec.value) - 3.14159) < 1e-4)
    } finally {
      close()
    }
  })

  test(`[${framing}] exception surfaces as typed error`, async () => {
    const { client, close } = await setup(framing)
    try {
      const resp = await client.request(1, buildReadRequest(1, 0, 8)) // coils => illegal
      assert.throws(
        () => parseWriteResponse(resp),
        (e: unknown) => e instanceof ModbusExceptionError
      )
    } finally {
      close()
    }
  })

  test(`[${framing}] sequential requests all match`, async () => {
    const { client, handler, close } = await setup(framing)
    try {
      for (let i = 0; i < 20; i++) handler.hr.set(i, i * 3)
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => client.request(1, buildReadRequest(3, i, 1)))
      )
      results.forEach((resp, i) => {
        const regs = parseReadRegistersResponse(resp, 1)
        assert.equal(regs.readUInt16BE(0), i * 3)
      })
    } finally {
      close()
    }
  })
}
