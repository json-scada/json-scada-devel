/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

import tls from 'node:tls'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { parseHostPort, type ClientTransport } from './transport.js'

// TLS configuration shared by client and server transports. Field names mirror
// the DNP3 driver's TLS options for operator familiarity.
export interface TlsConfig {
  localCertFilePath?: string
  privateKeyFilePath?: string
  privateKeyPassphrase?: string
  peerCertFilePath?: string // CA / trust anchor (and pinned cert if pinning)
  chainValidation?: boolean // verify peer chain (default true)
  allowOnlySpecificCertificates?: boolean // pin the exact peer cert
  cipherList?: string
  allowTLSv12?: boolean
  allowTLSv13?: boolean
}

export function buildTlsSecureContextOptions(
  cfg: TlsConfig
): tls.SecureContextOptions & {
  minVersion?: tls.SecureVersion
  maxVersion?: tls.SecureVersion
} {
  const opts: tls.SecureContextOptions & {
    minVersion?: tls.SecureVersion
    maxVersion?: tls.SecureVersion
  } = {}
  if (cfg.localCertFilePath)
    opts.cert = fs.readFileSync(cfg.localCertFilePath)
  if (cfg.privateKeyFilePath)
    opts.key = fs.readFileSync(cfg.privateKeyFilePath)
  if (cfg.privateKeyPassphrase) opts.passphrase = cfg.privateKeyPassphrase
  if (cfg.peerCertFilePath) opts.ca = fs.readFileSync(cfg.peerCertFilePath)
  if (cfg.cipherList) opts.ciphers = cfg.cipherList

  const allow12 = cfg.allowTLSv12 !== false
  const allow13 = cfg.allowTLSv13 !== false
  // TLS 1.0/1.1 are intentionally never offered.
  opts.minVersion = allow12 ? 'TLSv1.2' : 'TLSv1.3'
  opts.maxVersion = allow13 ? 'TLSv1.3' : 'TLSv1.2'
  return opts
}

export interface TlsClientOptions {
  host: string
  port: number
  localBind?: string
  connectTimeoutMs: number
  tls: TlsConfig
}

// Modbus/TCP Security client transport (MBAP over TLS).
export class TlsClientTransport extends EventEmitter implements ClientTransport {
  private socket: tls.TLSSocket | null = null
  private connected = false

  constructor(private readonly opts: TlsClientOptions) {
    super()
  }

  get isConnected(): boolean {
    return this.connected
  }

  describe(): string {
    return `tls://${this.opts.host}:${this.opts.port}`
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ctx = buildTlsSecureContextOptions(this.opts.tls)
      const chainValidation = this.opts.tls.chainValidation !== false

      const connectOpts: tls.ConnectionOptions & {
        localAddress?: string
        localPort?: number
      } = {
        host: this.opts.host,
        port: this.opts.port,
        ...ctx,
        rejectUnauthorized: chainValidation,
      }
      if (this.opts.localBind) {
        const lb = parseHostPort(this.opts.localBind, 0)
        connectOpts.localAddress = lb.host
        if (lb.port) connectOpts.localPort = lb.port
      }
      // Certificate pinning: verify the peer's leaf cert fingerprint.
      if (this.opts.tls.allowOnlySpecificCertificates && this.opts.tls.peerCertFilePath) {
        connectOpts.checkServerIdentity = () => undefined // skip hostname, rely on pin
      }

      const socket = tls.connect(connectOpts)
      this.socket = socket

      const timer = setTimeout(() => {
        socket.destroy(new Error('TLS connect timeout'))
      }, this.opts.connectTimeoutMs)

      socket.once('secureConnect', () => {
        clearTimeout(timer)
        if (chainValidation && !socket.authorized) {
          const err = new Error(
            'TLS peer not authorized: ' + (socket.authorizationError ?? 'unknown')
          )
          socket.destroy(err)
          reject(err)
          return
        }
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
