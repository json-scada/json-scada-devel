import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { EventEmitter, once } from 'node:events'
import Log from '../../src/common/simple-logger.js'
import { makeStackLogger } from '../../src/common/stack-logger.js'
import { ClientStack, type FramingMode } from '../../src/core/client-stack.js'
import { TcpClientTransport } from '../../src/core/transport-tcp.js'
import {
  ServerStackLink,
  type RequestHandler,
  type RequestContext,
  type HandlerResult,
  type ServerLink,
} from '../../src/core/server-stack.js'
import {
  buildReadRequest,
  buildWriteSingleRegister,
  EXCEPTION,
} from '../../src/core/pdu.js'

// Server that serves holding registers 0..9 and rejects everything else, so we
// can exercise both the happy path and the request-error paths.
class Handler implements RequestHandler {
  acceptsUnit(): boolean {
    return true
  }
  private exc(code: number): HandlerResult {
    return { kind: 'exception', code }
  }
  readCoils(): HandlerResult {
    return this.exc(EXCEPTION.ILLEGAL_DATA_ADDRESS)
  }
  readDiscreteInputs(): HandlerResult {
    return this.exc(EXCEPTION.ILLEGAL_DATA_ADDRESS)
  }
  readHolding(_c: RequestContext, start: number, qty: number): HandlerResult {
    if (start + qty > 10) return this.exc(EXCEPTION.ILLEGAL_DATA_ADDRESS)
    return { kind: 'registers', registers: Buffer.alloc(qty * 2, 0x11) }
  }
  readInput(): HandlerResult {
    return this.exc(EXCEPTION.ILLEGAL_DATA_ADDRESS)
  }
  writeSingleCoil(): HandlerResult {
    return this.exc(EXCEPTION.ILLEGAL_FUNCTION)
  }
  writeSingleRegister(): HandlerResult {
    return this.exc(EXCEPTION.ILLEGAL_DATA_ADDRESS)
  }
  writeMultipleCoils(): HandlerResult {
    return this.exc(EXCEPTION.ILLEGAL_FUNCTION)
  }
  writeMultipleRegisters(): HandlerResult {
    return this.exc(EXCEPTION.ILLEGAL_FUNCTION)
  }
  maskWriteRegister(): HandlerResult {
    return this.exc(EXCEPTION.ILLEGAL_FUNCTION)
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
    return '10.0.0.7:5020'
  }
}

// Capture everything the shared logger emits during `fn`.
async function capture(level: number, fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const orig = console.log
  const prevLevel = Log.levelCurrent
  Log.levelCurrent = level
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    await fn()
  } finally {
    console.log = orig
    Log.levelCurrent = prevLevel
  }
  return lines
}

async function withLink(
  framing: FramingMode,
  fn: (client: ClientStack) => Promise<void>
): Promise<void> {
  const accepted: net.Socket[] = []
  const server = net.createServer((socket) => {
    accepted.push(socket)
    new ServerStackLink(
      new SocketServerLink(socket),
      framing,
      new Handler(),
      false,
      makeStackLogger('SRV')
    )
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
      responseTimeoutMs: 800,
      maxRetries: 0,
      interRequestDelayMs: 0,
      interFrameDelayMs: 5,
    },
    5,
    makeStackLogger('CLI')
  )
  await transport.connect()
  try {
    await fn(client)
  } finally {
    transport.close()
    for (const sk of accepted) sk.destroy()
    server.close()
  }
}

test('logLevel 3 traces client TX/RX frames with hex and decoded PDU', async () => {
  const lines = await capture(Log.levelDebug, async () => {
    await withLink('mbap', async (client) => {
      await client.request(1, buildReadRequest(3, 0, 2))
    })
  })

  const tx = lines.find((l) => l.includes('CLI: TX'))
  const rx = lines.find((l) => l.includes('CLI: RX unit='))
  assert.ok(tx, 'expected a client TX trace\n' + lines.join('\n'))
  assert.ok(rx, 'expected a client RX trace\n' + lines.join('\n'))
  // decoded request summary
  assert.match(tx!, /fc=3 READ_HOLDING_REGISTERS addr=0 qty=2/)
  // raw ADU hex present
  assert.match(tx!, /ADU: [0-9A-F]{2}( [0-9A-F]{2})+/)
  assert.match(rx!, /fc=3 READ_HOLDING_REGISTERS bytes=4/)
  assert.match(rx!, /PDU: 03 04 11 11 11 11/)
})

test('logLevel 3 traces server RX/TX frames', async () => {
  const lines = await capture(Log.levelDebug, async () => {
    await withLink('mbap', async (client) => {
      await client.request(1, buildReadRequest(3, 0, 1))
    })
  })
  const srvRx = lines.find((l) => l.includes('SRV: [10.0.0.7:5020] RX unit=1'))
  const srvTx = lines.find((l) => l.includes('SRV: [10.0.0.7:5020] TX unit=1'))
  assert.ok(srvRx, 'expected server RX trace\n' + lines.join('\n'))
  assert.ok(srvTx, 'expected server TX trace\n' + lines.join('\n'))
  assert.match(srvRx!, /fc=3 READ_HOLDING_REGISTERS addr=0 qty=1/)
  assert.match(srvRx!, /PDU: 03 00 00 00 01/)
  assert.match(srvTx!, /ADU: /)
})

test('server logs request errors at normal level (not only debug)', async () => {
  // levelNormal (1): frame traces must be absent, request errors must be present
  const lines = await capture(Log.levelNormal, async () => {
    await withLink('mbap', async (client) => {
      // out-of-range read -> ILLEGAL DATA ADDRESS
      await client.request(1, buildReadRequest(3, 100, 2))
      // unsupported write -> ILLEGAL DATA ADDRESS from the handler
      await client.request(1, buildWriteSingleRegister(5, 1234))
    })
  })

  const errs = lines.filter((l) => l.includes('request error'))
  assert.ok(errs.length >= 2, 'expected request errors\n' + lines.join('\n'))
  assert.match(errs[0]!, /\[10\.0\.0\.7:5020\] request error: unit=1/)
  assert.match(errs[0]!, /fc=3 READ_HOLDING_REGISTERS addr=100 qty=2/)
  assert.match(errs[0]!, /exception 0x02 ILLEGAL DATA ADDRESS/)
  assert.match(errs[1]!, /fc=6 WRITE_SINGLE_REGISTER addr=5 value=1234/)

  // no low-level frame traces at this level
  assert.equal(
    lines.some((l) => l.includes('ADU:') || l.includes('link RX')),
    false,
    'frame traces must not appear below logLevel 3'
  )
})

test('server logs an illegal function code as a request error', async () => {
  const lines = await capture(Log.levelNormal, async () => {
    await withLink('mbap', async (client) => {
      // FC 99 is not implemented -> ILLEGAL FUNCTION
      const pdu = Buffer.from([99, 0x00, 0x00, 0x00, 0x01])
      await client.request(1, pdu)
    })
  })
  const err = lines.find((l) => l.includes('request error'))
  assert.ok(err, 'expected an illegal-function request error\n' + lines.join('\n'))
  assert.match(err!, /exception 0x01 ILLEGAL FUNCTION/)
})

test('client logs a response timeout', async () => {
  // server that accepts the connection but never answers
  const accepted: net.Socket[] = []
  const server = net.createServer((sk) => {
    accepted.push(sk)
  })
  server.listen(0)
  await once(server, 'listening')
  const port = (server.address() as net.AddressInfo).port

  const lines = await capture(Log.levelDebug, async () => {
    const transport = new TcpClientTransport({
      host: '127.0.0.1',
      port,
      connectTimeoutMs: 2000,
    })
    const client = new ClientStack(
      transport,
      'mbap',
      {
        responseTimeoutMs: 120,
        maxRetries: 1,
        interRequestDelayMs: 0,
        interFrameDelayMs: 5,
      },
      5,
      makeStackLogger('CLI')
    )
    await transport.connect()
    await client.request(1, buildReadRequest(3, 0, 1)).catch(() => {})
    transport.close()
  })
  for (const sk of accepted) sk.destroy()
  server.close()

  assert.ok(
    lines.some((l) => l.includes('response timeout') && l.includes('retrying')),
    'expected a retry trace\n' + lines.join('\n')
  )
  assert.ok(
    lines.some((l) => l.includes('no retries left')),
    'expected a final timeout trace\n' + lines.join('\n')
  )
})

test('logLevel 1 stays quiet on the client happy path', async () => {
  const lines = await capture(Log.levelNormal, async () => {
    await withLink('mbap', async (client) => {
      await client.request(1, buildReadRequest(3, 0, 2))
    })
  })
  assert.deepEqual(lines, [], 'no logging expected for a successful poll at level 1')
})
