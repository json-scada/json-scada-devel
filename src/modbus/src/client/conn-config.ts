/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Parsing and normalization of a MODBUS protocolConnections document.

import type { TlsConfig } from '../core/transport-tls.js'

export type ConnectionMode =
  | 'TCP Active'
  | 'TLS Active'
  | 'Serial'
  | 'RTU over TCP'
  | 'RTU over TLS'

export interface ModbusClientConnection {
  protocolConnectionNumber: number
  name: string
  enabled: boolean
  commandsEnabled: boolean

  connectionMode: ConnectionMode
  ipAddresses: string[]
  ipAddressLocalBind: string
  portName: string
  baudRate: number
  parity: string
  stopBits: string
  handshake: string

  timeoutMs: number
  maxRetries: number
  pollingIntervalMs: number
  giIntervalS: number
  interRequestDelayMs: number
  interFrameDelayMs: number

  maxReadRegisters: number
  maxReadCoils: number
  maxAddressGap: number

  byteOrder16: string
  byteOrder32: string
  byteOrder64: string
  byteOrderStr: string
  stringEncoding: 'latin1' | 'utf8' | 'ascii'
  useModiconAddresses: boolean
  useMaskWrite: boolean

  tls: TlsConfig

  autoCreateTags: boolean
  topics: string[]

  keepProtocolRunningWhileInactive: boolean
}

function num(v: unknown, dflt: number): number {
  if (v === null || v === undefined || v === '') return dflt
  const n = typeof v === 'object' && v && 'valueOf' in v ? Number(v) : Number(v)
  return Number.isFinite(n) ? n : dflt
}
function str(v: unknown, dflt: string): string {
  return typeof v === 'string' && v !== '' ? v : dflt
}
function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt
}
function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

export function normalizeConnection(
  doc: Record<string, unknown>
): ModbusClientConnection {
  const mode = str(doc.connectionMode, 'TCP Active') as ConnectionMode
  return {
    protocolConnectionNumber: num(doc.protocolConnectionNumber, 0),
    name: str(doc.name, 'MODBUS-' + num(doc.protocolConnectionNumber, 0)),
    enabled: bool(doc.enabled, true),
    commandsEnabled: bool(doc.commandsEnabled, true),

    connectionMode: mode,
    ipAddresses: arr(doc.ipAddresses),
    ipAddressLocalBind: str(doc.ipAddressLocalBind, ''),
    portName: str(doc.portName, ''),
    baudRate: num(doc.baudRate, 9600),
    parity: str(doc.parity, 'Even'),
    stopBits: str(doc.stopBits, 'One'),
    handshake: str(doc.handshake, 'None'),

    timeoutMs: num(doc.timeoutMs, 1000),
    maxRetries: num(doc.maxRetries, 2),
    pollingIntervalMs: num(doc.pollingInterval, 1000),
    giIntervalS: num(doc.giInterval, 300),
    interRequestDelayMs: num(doc.interRequestDelayMs, 0),
    interFrameDelayMs: num(doc.interFrameDelayMs, 0),

    maxReadRegisters: Math.min(125, num(doc.maxReadRegisters, 125)),
    maxReadCoils: Math.min(2000, num(doc.maxReadCoils, 2000)),
    maxAddressGap: num(doc.maxAddressGap, 8),

    byteOrder16: str(doc.byteOrder16, 'AB'),
    byteOrder32: str(doc.byteOrder32, 'ABCD'),
    byteOrder64: str(doc.byteOrder64, 'ABCDEFGH'),
    byteOrderStr: str(doc.byteOrderStr, 'AB'),
    stringEncoding: str(doc.stringEncoding, 'latin1') as
      | 'latin1'
      | 'utf8'
      | 'ascii',
    useModiconAddresses: bool(doc.useModiconAddresses, false),
    useMaskWrite: bool(doc.useMaskWrite, true),

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

    autoCreateTags: bool(doc.autoCreateTags, false),
    topics: arr(doc.topics),

    keepProtocolRunningWhileInactive: bool(
      doc.keepProtocolRunningWhileInactive,
      false
    ),
  }
}

export function isTlsMode(mode: ConnectionMode): boolean {
  return mode === 'TLS Active' || mode === 'RTU over TLS'
}
export function isSerialMode(mode: ConnectionMode): boolean {
  return mode === 'Serial'
}
export function isRtuFraming(mode: ConnectionMode): boolean {
  return mode === 'Serial' || mode === 'RTU over TCP' || mode === 'RTU over TLS'
}
export function defaultPortForMode(mode: ConnectionMode): number {
  return isTlsMode(mode) ? 802 : 502
}
