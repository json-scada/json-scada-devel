/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Parsing and normalization of a MODBUS_SERVER protocolConnections document.

import type { TlsConfig } from '../core/transport-tls.js'

export type ServerMode =
  | 'TCP Passive'
  | 'TLS Passive'
  | 'Serial'
  | 'RTU over TCP Passive'
  | 'RTU over TLS Passive'

export interface ModbusServerConnection {
  protocolConnectionNumber: number
  name: string
  enabled: boolean
  commandsEnabled: boolean

  connectionMode: ServerMode
  ipAddressLocalBind: string
  maxClientConnections: number
  clientIdleTimeoutMs: number
  ipAddresses: string[] // client allow-list (empty = any)

  portName: string
  baudRate: number
  parity: string
  stopBits: string
  handshake: string
  interFrameDelayMs: number

  serverUnitIds: number[]
  strictUnitId: boolean
  serveUnmappedAsZero: boolean

  byteOrder16: string
  byteOrder32: string
  byteOrder64: string
  byteOrderStr: string
  stringEncoding: 'latin1' | 'utf8' | 'ascii'
  useModiconAddresses: boolean
  invalidValuePolicy: 'last' | 'zero'
  allowWritesToSupervised: boolean

  tls: TlsConfig

  keepProtocolRunningWhileInactive: boolean
}

function num(v: unknown, dflt: number): number {
  if (v === null || v === undefined || v === '') return dflt
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}
function str(v: unknown, dflt: string): string {
  return typeof v === 'string' && v !== '' ? v : dflt
}
function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}
function numArr(v: unknown, dflt: number[]): number[] {
  if (!Array.isArray(v)) return dflt
  const out = v.map((x) => Math.round(Number(x))).filter((n) => Number.isFinite(n))
  return out.length ? out : dflt
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

export function normalizeServerConnection(
  doc: Record<string, unknown>
): ModbusServerConnection {
  const mode = str(doc.connectionMode, 'TCP Passive') as ServerMode
  return {
    protocolConnectionNumber: num(doc.protocolConnectionNumber, 0),
    name: str(doc.name, 'MODBUS_SERVER-' + num(doc.protocolConnectionNumber, 0)),
    enabled: bool(doc.enabled, true),
    commandsEnabled: bool(doc.commandsEnabled, true),

    connectionMode: mode,
    ipAddressLocalBind: str(doc.ipAddressLocalBind, '0.0.0.0:502'),
    maxClientConnections: num(doc.maxClientConnections, 8),
    clientIdleTimeoutMs: num(doc.clientIdleTimeoutMs, 60000),
    ipAddresses: strArr(doc.ipAddresses),

    portName: str(doc.portName, ''),
    baudRate: num(doc.baudRate, 9600),
    parity: str(doc.parity, 'Even'),
    stopBits: str(doc.stopBits, 'One'),
    handshake: str(doc.handshake, 'None'),
    interFrameDelayMs: num(doc.interFrameDelayMs, 0),

    serverUnitIds: numArr(doc.serverUnitIds, [1]),
    strictUnitId: bool(doc.strictUnitId, false),
    serveUnmappedAsZero: bool(doc.serveUnmappedAsZero, false),

    byteOrder16: str(doc.byteOrder16, 'AB'),
    byteOrder32: str(doc.byteOrder32, 'ABCD'),
    byteOrder64: str(doc.byteOrder64, 'ABCDEFGH'),
    byteOrderStr: str(doc.byteOrderStr, 'AB'),
    stringEncoding: str(doc.stringEncoding, 'latin1') as
      | 'latin1'
      | 'utf8'
      | 'ascii',
    useModiconAddresses: bool(doc.useModiconAddresses, false),
    invalidValuePolicy: str(doc.invalidValuePolicy, 'last') as 'last' | 'zero',
    allowWritesToSupervised: bool(doc.allowWritesToSupervised, false),

    tls: {
      localCertFilePath: str(doc.localCertFilePath, ''),
      privateKeyFilePath: str(doc.privateKeyFilePath, ''),
      privateKeyPassphrase: str(doc.privateKeyPassphrase, ''),
      peerCertFilePath: str(doc.peerCertFilePath, ''),
      chainValidation: bool(doc.chainValidation, true),
      allowOnlySpecificCertificates: bool(doc.allowOnlySpecificCertificates, false),
      cipherList: str(doc.cipherList, ''),
      allowTLSv12: bool(doc.allowTLSv12, true),
      allowTLSv13: bool(doc.allowTLSv13, true),
    },

    keepProtocolRunningWhileInactive: bool(
      doc.keepProtocolRunningWhileInactive,
      false
    ),
  }
}

export function isTlsServerMode(mode: ServerMode): boolean {
  return mode === 'TLS Passive' || mode === 'RTU over TLS Passive'
}
export function isSerialServerMode(mode: ServerMode): boolean {
  return mode === 'Serial'
}
export function isRtuServerFraming(mode: ServerMode): boolean {
  return (
    mode === 'Serial' ||
    mode === 'RTU over TCP Passive' ||
    mode === 'RTU over TLS Passive'
  )
}
export function defaultServerPort(mode: ServerMode): number {
  return isTlsServerMode(mode) ? 802 : 502
}
