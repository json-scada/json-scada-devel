/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Transport abstraction. A ClientTransport is a bidirectional byte pipe to one
// device (TCP socket, TLS socket, serial port, or RTU-over-TCP socket). The
// client stack sits on top and never needs to know which one it is.

import { EventEmitter } from 'node:events'

export interface ClientTransport extends EventEmitter {
  // Open the link. Resolves when connected (or rejects on failure).
  connect(): Promise<void>
  // Write raw bytes to the wire.
  write(data: Buffer): void
  // Close the link.
  close(): void
  // Human-readable description of the current peer, for logging/stats.
  describe(): string
  readonly isConnected: boolean

  // events: 'connect', 'data' (Buffer), 'error' (Error), 'close'
}

// Parse "host:port" (IPv4/hostname) or "[ipv6]:port" into components.
export function parseHostPort(
  s: string,
  defaultPort: number
): { host: string; port: number } {
  const str = s.trim()
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(str)
  if (v6) return { host: v6[1]!, port: parseInt(v6[2]!, 10) }
  const v6NoPort = /^\[([^\]]+)\]$/.exec(str)
  if (v6NoPort) return { host: v6NoPort[1]!, port: defaultPort }
  const idx = str.lastIndexOf(':')
  if (idx >= 0 && str.indexOf(':') === idx) {
    return { host: str.slice(0, idx), port: parseInt(str.slice(idx + 1), 10) }
  }
  return { host: str, port: defaultPort }
}
