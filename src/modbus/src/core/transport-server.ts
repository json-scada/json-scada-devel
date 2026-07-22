/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Server-side transports. Each listener emits 'connection' events carrying a
// ServerLink (a per-client byte pipe). Serial emits a single persistent link.

import net from 'node:net'
import tls from 'node:tls'
import { EventEmitter } from 'node:events'
import type { ServerLink } from './server-stack.js'
import { parseHostPort } from './transport.js'
import {
  buildTlsSecureContextOptions,
  type TlsConfig,
} from './transport-tls.js'
import type { SerialOptions } from './transport-serial.js'

class SocketLink extends EventEmitter implements ServerLink {
  constructor(private readonly socket: net.Socket) {
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
    return `${this.socket.remoteAddress}:${this.socket.remotePort}`
  }
}

export interface ServerListener extends EventEmitter {
  listen(): Promise<void>
  close(): void
  // events: 'connection' (ServerLink), 'error' (Error), 'listening'
}

export interface TcpServerOptions {
  bind: string // "ip:port"
  defaultPort: number
  maxClients: number
  idleTimeoutMs: number
  allowList: string[] // empty = any
}

export class TcpServerListener extends EventEmitter implements ServerListener {
  private server: net.Server | null = null
  private clients = new Set<net.Socket>()

  constructor(private readonly opts: TcpServerOptions) {
    super()
  }

  listen(): Promise<void> {
    const { host, port } = parseHostPort(this.opts.bind, this.opts.defaultPort)
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onSocket(socket))
      this.server = server
      server.on('error', (e) => {
        this.emit('error', e)
        reject(e)
      })
      server.listen(port, host === '' ? undefined : host, () => {
        this.emit('listening')
        resolve()
      })
    })
  }

  private onSocket(socket: net.Socket): void {
    if (!this.allowed(socket) || this.clients.size >= this.opts.maxClients) {
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    if (this.opts.idleTimeoutMs > 0) socket.setTimeout(this.opts.idleTimeoutMs)
    socket.on('timeout', () => socket.destroy())
    this.clients.add(socket)
    socket.on('close', () => this.clients.delete(socket))
    this.emit('connection', new SocketLink(socket))
  }

  private allowed(socket: net.Socket): boolean {
    if (this.opts.allowList.length === 0) return true
    const addr = (socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    return this.opts.allowList.some((a) => a.replace(/^::ffff:/, '') === addr)
  }

  close(): void {
    for (const c of this.clients) c.destroy()
    this.clients.clear()
    this.server?.close()
    this.server = null
  }
}

// Serial RTU slave: a single persistent link. The serialport module is imported
// lazily so TCP/TLS-only servers never load the native binding.
class SerialServerLink extends EventEmitter implements ServerLink {
  constructor(private readonly port: import('serialport').SerialPort) {
    super()
    port.on('data', (d: Buffer) => this.emit('data', d))
    port.on('close', () => this.emit('close'))
  }
  write(data: Buffer): void {
    this.port.write(data)
  }
  close(): void {
    try {
      this.port.close(() => {})
    } catch {
      // ignore
    }
  }
  describe(): string {
    return 'serial'
  }
}

export class SerialServerListener extends EventEmitter implements ServerListener {
  private port: import('serialport').SerialPort | null = null

  constructor(private readonly opts: SerialOptions) {
    super()
  }

  async listen(): Promise<void> {
    const { SerialPort } = await import('serialport')
    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort(
        {
          path: this.opts.portName,
          baudRate: this.opts.baudRate,
          parity: this.opts.parity,
          stopBits: this.opts.stopBits,
          dataBits: this.opts.dataBits,
          rtscts: this.opts.rtscts,
          xon: this.opts.xon,
          xoff: this.opts.xoff,
          autoOpen: false,
        },
        () => {}
      )
      this.port = port
      port.open((err) => {
        if (err) {
          reject(err)
          return
        }
        this.emit('listening')
        this.emit('connection', new SerialServerLink(port))
        resolve()
      })
      port.on('error', (e: Error) => this.emit('error', e))
    })
  }

  close(): void {
    try {
      this.port?.close(() => {})
    } catch {
      // ignore
    }
    this.port = null
  }
}

export interface TlsServerOptions extends TcpServerOptions {
  tls: TlsConfig
}

export class TlsServerListener extends EventEmitter implements ServerListener {
  private server: tls.Server | null = null
  private clients = new Set<tls.TLSSocket>()

  constructor(private readonly opts: TlsServerOptions) {
    super()
  }

  listen(): Promise<void> {
    const { host, port } = parseHostPort(this.opts.bind, this.opts.defaultPort)
    const ctx = buildTlsSecureContextOptions(this.opts.tls)
    const requireClientCert = this.opts.tls.chainValidation !== false
    const serverOpts: tls.TlsOptions = {
      ...ctx,
      requestCert: requireClientCert,
      rejectUnauthorized: requireClientCert,
    }
    return new Promise((resolve, reject) => {
      const server = tls.createServer(serverOpts, (socket) =>
        this.onSocket(socket)
      )
      this.server = server
      server.on('error', (e) => {
        this.emit('error', e)
        reject(e)
      })
      server.on('tlsClientError', (e) => this.emit('error', e))
      server.listen(port, host === '' ? undefined : host, () => {
        this.emit('listening')
        resolve()
      })
    })
  }

  private onSocket(socket: tls.TLSSocket): void {
    if (!this.allowed(socket) || this.clients.size >= this.opts.maxClients) {
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    if (this.opts.idleTimeoutMs > 0) socket.setTimeout(this.opts.idleTimeoutMs)
    socket.on('timeout', () => socket.destroy())
    this.clients.add(socket)
    socket.on('close', () => this.clients.delete(socket))
    this.emit('connection', new SocketLink(socket))
  }

  private allowed(socket: net.Socket): boolean {
    if (this.opts.allowList.length === 0) return true
    const addr = (socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    return this.opts.allowList.some((a) => a.replace(/^::ffff:/, '') === addr)
  }

  close(): void {
    for (const c of this.clients) c.destroy()
    this.clients.clear()
    this.server?.close()
    this.server = null
  }
}
