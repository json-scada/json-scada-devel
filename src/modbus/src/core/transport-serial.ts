/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

import { EventEmitter } from 'node:events'
import { type ClientTransport } from './transport.js'

export interface SerialOptions {
  portName: string
  baudRate: number
  parity: 'none' | 'even' | 'odd' | 'mark' | 'space'
  stopBits: 1 | 2
  dataBits: 5 | 6 | 7 | 8
  rtscts: boolean
  xon: boolean
  xoff: boolean
}

// Map the AdminUI serial field enums to the serialport option values.
export function mapParity(
  s: string | undefined
): SerialOptions['parity'] {
  switch ((s ?? 'none').toLowerCase()) {
    case 'even':
      return 'even'
    case 'odd':
      return 'odd'
    case 'mark':
      return 'mark'
    case 'space':
      return 'space'
    default:
      return 'none'
  }
}

export function mapStopBits(s: string | undefined): 1 | 2 {
  // AdminUI: 'One' | 'One5' | 'Two'. serialport supports 1, 1.5, 2 but Modbus
  // RTU uses whole stop bits; One5 falls back to 2 for framing safety.
  switch ((s ?? 'One').toLowerCase()) {
    case 'two':
    case 'one5':
      return 2
    default:
      return 1
  }
}

export function mapHandshake(s: string | undefined): {
  rtscts: boolean
  xon: boolean
  xoff: boolean
} {
  switch ((s ?? 'None').toLowerCase()) {
    case 'rts':
      return { rtscts: true, xon: false, xoff: false }
    case 'xon':
      return { rtscts: false, xon: true, xoff: true }
    case 'rtsxon':
      return { rtscts: true, xon: true, xoff: true }
    default:
      return { rtscts: false, xon: false, xoff: false }
  }
}

// Serial RTU transport. The serialport module is imported lazily so that
// TCP/TLS-only deployments never load the native binding.
export class SerialTransport extends EventEmitter implements ClientTransport {
  private port: import('serialport').SerialPort | null = null
  private connected = false

  constructor(private readonly opts: SerialOptions) {
    super()
  }

  get isConnected(): boolean {
    return this.connected
  }

  describe(): string {
    return `serial://${this.opts.portName}@${this.opts.baudRate}`
  }

  async connect(): Promise<void> {
    const { SerialPort } = await import('serialport')
    return new Promise<void>((resolve, reject) => {
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
        (err) => {
          if (err) reject(err)
        }
      )
      this.port = port
      port.open((err) => {
        if (err) {
          reject(err)
          return
        }
        this.connected = true
        this.emit('connect')
        resolve()
      })
      port.on('data', (d: Buffer) => this.emit('data', d))
      port.on('error', (err: Error) => {
        if (!this.connected) reject(err)
        this.emit('error', err)
      })
      port.on('close', () => {
        this.connected = false
        this.emit('close')
      })
    })
  }

  write(data: Buffer): void {
    this.port?.write(data)
  }

  close(): void {
    this.connected = false
    try {
      this.port?.close(() => {})
    } catch {
      // ignore
    }
    this.port = null
  }
}
