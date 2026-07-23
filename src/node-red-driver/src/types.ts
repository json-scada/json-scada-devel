/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import type { MongoClientOptions } from 'mongodb'

// Runtime configuration assembled by load-config.ts.
export interface DriverConfig {
  mongoConnectionString: string
  mongoDatabaseName: string
  nodeName: string

  Instance: number
  LogLevel: number

  GridFsCollectionName: string
  RealtimeDataCollectionName: string
  SoeDataCollectionName: string
  CommandsQueueCollectionName: string
  ProtocolDriverInstancesCollectionName: string
  ProtocolConnectionsCollectionName: string
  GroupSep: string
  ConnectionNumber: number

  MongoConnectionOptions: MongoClientOptions

  // TLS-to-MongoDB passthrough fields (as in json-scada.json).
  tlsCaPemFile?: string
  tlsClientPemFile?: string
  tlsClientKeyPassword?: string
  tlsAllowInvalidHostnames?: boolean
  tlsAllowChainErrors?: boolean
  tlsInsecure?: boolean
}

// The single protocolConnections document owned by this instance.
export interface ConnectionDoc {
  protocolDriver: string
  protocolDriverInstanceNumber: number
  protocolConnectionNumber: number
  name: string
  description?: string
  enabled: boolean
  commandsEnabled?: boolean
  autoCreateTags?: boolean
  ipAddressLocalBind?: string
  ipAddresses?: string[]
  topics?: string[]
  endpointURLs?: string[]
  username?: string
  password?: string
  // WS-server TLS (optional). When both cert+key are set the server serves wss://.
  localCertFilePath?: string
  privateKeyFilePath?: string
  rootCertFilePath?: string
  chainValidation?: boolean
  allowTLSv10?: boolean
  allowTLSv11?: boolean
  allowTLSv12?: boolean
  allowTLSv13?: boolean
  cipherList?: string
}

// A value produced by a flow, addressed by protocolSourceObjectAddress.
export interface IngestPoint {
  address: string
  value: number | boolean | string | object | null
  pointType?: 'analog' | 'digital' | 'string' | 'json'
  invalid?: boolean
  timestamp?: string | number | Date
  timestampOk?: boolean
  description?: string
  ungroupedDescription?: string
  group1?: string
  group2?: string
  group3?: string
  unit?: string
  isEvent?: boolean
  // Command-tag declaration (jsonscada tag out with commandable:true).
  commandable?: boolean
  supervisedAddress?: string
}

// A tag update pushed to subscribed WS clients.
export interface PublishTag {
  tag: string
  pointKey: number
  value: number
  valueString: string
  valueJson: unknown
  invalid: boolean
  alarmed: boolean
  timeTag: string | null
  timeTagAtSource: string | null
  timeTagAtSourceOk: boolean
  group1: string
  group2: string
  group3: string
  type: string
  description: string
  unit: string
  cot: number
}

// Per-client subscription spec.
export interface Subscription {
  all: boolean
  tags: Set<string>
  topics: Set<string>
  commands: boolean
  snapshot: boolean
}

// ---- WebSocket protocol messages (see PROTOCOL.md) ----

export type ClientMessage =
  | { type: 'hello'; token?: string; clientId?: string; protocolVersion?: number }
  | {
      type: 'subscribe'
      tags?: string[]
      topics?: string[]
      all?: boolean
      commands?: boolean
      snapshot?: boolean
    }
  | { type: 'ping' }
  | { type: 'updates'; data: IngestPoint[] }
  | { type: 'read'; tags?: string[]; topics?: string[] }
  | { type: 'command'; tag?: string; pointKey?: number; value: unknown }
  | { type: 'commandResult'; pointKey?: number; tag?: string; ok: boolean; error?: string }

export type ServerMessage =
  | {
      type: 'helloAck'
      connectionNumber: number
      connectionName: string
      protocolVersion: number
      serverVersion: string
    }
  | { type: 'error'; code: string; message?: string }
  | { type: 'update'; tags: PublishTag[] }
  | { type: 'snapshot'; tags: PublishTag[] }
  | {
      type: 'command'
      address: string
      tag: string
      value: number
      valueString: string
      pointKey: number
      timestamp: string
    }
  | { type: 'commandAck'; ok: boolean; tag?: string; error?: string | null }
  | { type: 'overflow'; dropped: number }
  | { type: 'stats'; stats: Record<string, number> }
  | { type: 'pong' }
