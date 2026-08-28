/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'
import {
  parseHostPort,
  type ClientTransport,
} from './transport.js'

export interface TcpClientOptions {
  host: string
  port: number
  localBind?: string // "ip" or "ip:port" for the local outgoing socket
  connectTimeoutMs: number
}

// Plain Modbus/TCP client transport over net.Socket.
export class TcpClientTransport extends EventEmitter implements ClientTransport {
  private socket: net.Socket | null = null
  private connected = false

  constructor(private readonly opts: TcpClientOptions) {
    super()
  }

  get isConnected(): boolean {
    return this.connected
  }

  describe(): string {
    return `tcp://${this.opts.host}:${this.opts.port}`
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const connectOpts: net.NetConnectOpts = {
        host: this.opts.host,
        port: this.opts.port,
      }
      if (this.opts.localBind) {
        const lb = parseHostPort(this.opts.localBind, 0)
        connectOpts.localAddress = lb.host
        if (lb.port) connectOpts.localPort = lb.port
      }

      const socket = net.connect(connectOpts)
      this.socket = socket
      socket.setNoDelay(true)

      const timer = setTimeout(() => {
        socket.destroy(new Error('connect timeout'))
      }, this.opts.connectTimeoutMs)

      socket.once('connect', () => {
        clearTimeout(timer)
        this.connected = true
        this.emit('connect')
        resolve()
      })
      socket.on('data', (d) => this.emit('data', d))
      socket.once('error', (err) => {
        clearTimeout(timer)
        if (!this.connected) reject(err)
        this.emit('error', err)
      })
      socket.once('close', () => {
        clearTimeout(timer)
        this.connected = false
        this.emit('close')
      })
    })
  }

  write(data: Buffer): void {
    this.socket?.write(data)
  }

  close(): void {
    this.connected = false
    this.socket?.destroy()
    this.socket = null
  }
}
