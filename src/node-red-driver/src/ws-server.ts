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

// WebSocket JSON server: TLS, token auth, IP allow-list, per-client subscriptions,
// outbound batching with overflow protection, and app-level keep-alive. Business
// logic (ingest, publish, commands) is injected via the Handlers callbacks so this
// module stays transport-only.

import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import * as crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import Log from './log.js'
import AppDefs from './app-defs.js'
import type {
  ClientMessage,
  ConnectionDoc,
  IngestPoint,
  PublishTag,
  ServerMessage,
  Subscription,
} from './types.js'

let clientSeq = 0

// One connected Node-RED flow. Tracks auth state, subscription, and a bounded
// outbound queue flushed on a timer.
export class Client {
  readonly id: number
  readonly ws: WebSocket
  readonly ip: string
  clientId = ''
  authed = false
  isAlive = true
  sub: Subscription = {
    all: false,
    tags: new Set(),
    topics: new Set(),
    commands: false,
    snapshot: true,
  }
  private outQueue: ServerMessage[] = []
  private droppedSinceFlush = 0

  constructor(ws: WebSocket, ip: string) {
    this.id = ++clientSeq
    this.ws = ws
    this.ip = ip
  }

  // Queues a message; on overflow drops oldest and remembers the count so the next
  // flush can emit an 'overflow' notice (the publisher then forces a snapshot).
  enqueue(msg: ServerMessage): void {
    if (this.outQueue.length >= AppDefs.MAX_CLIENT_QUEUE) {
      this.outQueue.shift()
      this.droppedSinceFlush++
    }
    this.outQueue.push(msg)
  }

  sendNow(msg: ServerMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  flush(): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.outQueue.length = 0
      return
    }
    if (this.droppedSinceFlush > 0) {
      this.sendNow({ type: 'overflow', dropped: this.droppedSinceFlush })
      this.droppedSinceFlush = 0
    }
    if (this.outQueue.length === 0) return
    const batch = this.outQueue
    this.outQueue = []
    for (const msg of batch) this.sendNow(msg)
  }

  // True when this client's subscription selects the given tag/group1.
  matches(tag: string, group1: string): boolean {
    if (this.sub.all) return true
    if (this.sub.tags.has(tag)) return true
    if (group1 && this.sub.topics.has(group1)) return true
    return false
  }
}

export interface Handlers {
  onUpdates(points: IngestPoint[], client: Client): void
  onSubscribe(client: Client): void
  onRead(client: Client, tags?: string[], topics?: string[]): void
  onCommand(
    client: Client,
    ref: { tag?: string; pointKey?: number; value: unknown }
  ): void
  onCommandResult(client: Client, pointKey?: number, tag?: string, ok?: boolean): void
}

export class WsServer {
  private conn: ConnectionDoc
  private handlers: Handlers
  private httpServer: http.Server | https.Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<Client>()
  private flushTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private token: string
  private allowIps: string[]

  constructor(conn: ConnectionDoc, handlers: Handlers) {
    this.conn = conn
    this.handlers = handlers
    this.token = (conn.password || '').trim()
    this.allowIps = Array.isArray(conn.ipAddresses) ? conn.ipAddresses : []
  }

  getClients(): Set<Client> {
    return this.clients
  }

  start(): void {
    const { address, port } = parseBind(this.conn.ipAddressLocalBind)
    const tlsOpts = buildTlsOptions(this.conn)

    this.httpServer = tlsOpts
      ? https.createServer(tlsOpts)
      : http.createServer()

    // IP allow-list enforced at the raw socket, before the WS upgrade completes.
    this.wss = new WebSocketServer({
      server: this.httpServer,
      verifyClient: (info, done) => {
        const ip = normalizeIp(info.req.socket.remoteAddress || '')
        if (this.allowIps.length > 0 && !this.allowIps.includes(ip)) {
          Log.log('WS - Rejected connection from disallowed IP ' + ip)
          done(false, 403, 'Forbidden')
          return
        }
        done(true)
      },
    })

    this.wss.on('connection', (ws, req) => this.onConnection(ws, req))
    this.wss.on('error', (err) => Log.log('WS - Server error: ' + err))

    this.httpServer.listen(port, address, () => {
      Log.log(
        'WS - ' +
          (tlsOpts ? 'wss' : 'ws') +
          ' server listening on ' +
          address +
          ':' +
          port
      )
    })
    this.httpServer.on('error', (err) => {
      Log.log('WS - HTTP server error: ' + err)
    })

    this.flushTimer = setInterval(
      () => this.flushAll(),
      AppDefs.PUBLISH_FLUSH_MS
    )
    this.pingTimer = setInterval(() => this.pingSweep(), AppDefs.WS_PING_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.flushTimer = null
    this.pingTimer = null
    for (const c of this.clients) {
      try {
        c.ws.close(1001, 'shutting down')
      } catch {
        /* ignore */
      }
    }
    this.clients.clear()
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve()
      this.wss.close(() => resolve())
    })
    await new Promise<void>((resolve) => {
      if (!this.httpServer) return resolve()
      this.httpServer.close(() => resolve())
    })
    this.wss = null
    this.httpServer = null
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const ip = normalizeIp(req.socket.remoteAddress || '')
    const client = new Client(ws, ip)
    this.clients.add(client)
    Log.log('WS - Client #' + client.id + ' connected from ' + ip)

    ws.on('pong', () => {
      client.isAlive = true
    })
    ws.on('message', (data) => this.onMessage(client, data.toString()))
    ws.on('close', () => {
      this.clients.delete(client)
      Log.log('WS - Client #' + client.id + ' disconnected')
    })
    ws.on('error', (err) => {
      Log.log('WS - Client #' + client.id + ' error: ' + err, Log.levelDetailed)
    })
  }

  private onMessage(client: Client, raw: string): void {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw) as ClientMessage
    } catch {
      client.sendNow({ type: 'error', code: 'badjson' })
      return
    }
    if (!msg || typeof (msg as { type?: unknown }).type !== 'string') {
      client.sendNow({ type: 'error', code: 'notype' })
      return
    }

    // Only 'hello' is allowed before authentication.
    if (!client.authed && msg.type !== 'hello') {
      client.sendNow({ type: 'error', code: 'unauth', message: 'send hello first' })
      return
    }

    switch (msg.type) {
      case 'hello':
        this.handleHello(client, msg)
        break
      case 'subscribe':
        this.handleSubscribe(client, msg)
        break
      case 'ping':
        client.sendNow({ type: 'pong' })
        break
      case 'updates':
        if (Array.isArray(msg.data)) this.handlers.onUpdates(msg.data, client)
        break
      case 'read':
        this.handlers.onRead(client, msg.tags, msg.topics)
        break
      case 'command':
        if (!this.conn.commandsEnabled) {
          client.sendNow({
            type: 'commandAck',
            ok: false,
            tag: msg.tag,
            error: 'commands disabled on this connection',
          })
          break
        }
        this.handlers.onCommand(client, {
          tag: msg.tag,
          pointKey: msg.pointKey,
          value: msg.value,
        })
        break
      case 'commandResult':
        this.handlers.onCommandResult(client, msg.pointKey, msg.tag, msg.ok)
        break
      default:
        client.sendNow({ type: 'error', code: 'unknowntype' })
    }
  }

  private handleHello(
    client: Client,
    msg: Extract<ClientMessage, { type: 'hello' }>
  ): void {
    if (this.token !== '') {
      const provided = (msg.token || '').trim()
      if (!timingSafeEqualStr(provided, this.token)) {
        Log.log('WS - Client #' + client.id + ' failed auth')
        client.sendNow({ type: 'error', code: 'auth', message: 'invalid token' })
        try {
          client.ws.close(4401, 'auth')
        } catch {
          /* ignore */
        }
        return
      }
    }
    client.authed = true
    client.clientId = (msg.clientId || '').slice(0, 128)
    client.sendNow({
      type: 'helloAck',
      connectionNumber: this.conn.protocolConnectionNumber,
      connectionName: this.conn.name,
      protocolVersion: AppDefs.PROTOCOL_VERSION,
      serverVersion: AppDefs.VERSION,
    })
    Log.log(
      'WS - Client #' + client.id + ' authenticated (clientId=' + client.clientId + ')'
    )
  }

  private handleSubscribe(
    client: Client,
    msg: Extract<ClientMessage, { type: 'subscribe' }>
  ): void {
    client.sub = {
      all: msg.all === true,
      tags: new Set(Array.isArray(msg.tags) ? msg.tags : []),
      topics: new Set(Array.isArray(msg.topics) ? msg.topics : []),
      commands: msg.commands === true,
      snapshot: msg.snapshot !== false,
    }
    Log.log(
      'WS - Client #' +
        client.id +
        ' subscribed (all=' +
        client.sub.all +
        ', tags=' +
        client.sub.tags.size +
        ', topics=' +
        client.sub.topics.size +
        ', commands=' +
        client.sub.commands +
        ')',
      Log.levelDetailed
    )
    this.handlers.onSubscribe(client)
  }

  // Fan-out a batch of publish tags to every subscribed, authenticated client.
  broadcast(tags: PublishTag[]): void {
    if (this.clients.size === 0) return
    for (const client of this.clients) {
      if (!client.authed) continue
      const selected = tags.filter((t) => client.matches(t.tag, t.group1))
      if (selected.length > 0) client.enqueue({ type: 'update', tags: selected })
    }
  }

  // Deliver an operator command to clients that requested command reception and match
  // the tag/group. Returns the number of clients the command was delivered to.
  deliverCommand(
    msg: Extract<ServerMessage, { type: 'command' }>,
    group1: string
  ): number {
    let delivered = 0
    for (const client of this.clients) {
      if (!client.authed || !client.sub.commands) continue
      if (!client.matches(msg.tag, group1)) continue
      client.enqueue(msg)
      delivered++
    }
    return delivered
  }

  private flushAll(): void {
    for (const client of this.clients) client.flush()
  }

  private pingSweep(): void {
    for (const client of this.clients) {
      if (!client.isAlive) {
        Log.log('WS - Reaping dead client #' + client.id, Log.levelDetailed)
        try {
          client.ws.terminate()
        } catch {
          /* ignore */
        }
        this.clients.delete(client)
        continue
      }
      client.isAlive = false
      try {
        client.ws.ping()
      } catch {
        /* ignore */
      }
    }
  }
}

function parseBind(bind?: string): { address: string; port: number } {
  if (!bind || bind.trim() === '')
    return {
      address: AppDefs.DEFAULT_BIND_ADDRESS,
      port: AppDefs.DEFAULT_BIND_PORT,
    }
  const idx = bind.lastIndexOf(':')
  if (idx === -1)
    return { address: bind, port: AppDefs.DEFAULT_BIND_PORT }
  const address = bind.slice(0, idx) || AppDefs.DEFAULT_BIND_ADDRESS
  const port = parseInt(bind.slice(idx + 1))
  return { address, port: Number.isNaN(port) ? AppDefs.DEFAULT_BIND_PORT : port }
}

function buildTlsOptions(conn: ConnectionDoc): https.ServerOptions | null {
  if (!conn.localCertFilePath || !conn.privateKeyFilePath) return null
  try {
    const opts: https.ServerOptions = {
      cert: fs.readFileSync(conn.localCertFilePath),
      key: fs.readFileSync(conn.privateKeyFilePath),
    }
    if (conn.rootCertFilePath) {
      opts.ca = fs.readFileSync(conn.rootCertFilePath)
      opts.requestCert = true
      opts.rejectUnauthorized = conn.chainValidation === true
    }
    const min = conn.allowTLSv10
      ? 'TLSv1'
      : conn.allowTLSv11
        ? 'TLSv1.1'
        : conn.allowTLSv12 !== false
          ? 'TLSv1.2'
          : 'TLSv1.3'
    opts.minVersion = min as https.ServerOptions['minVersion']
    if (conn.cipherList && conn.cipherList.trim() !== '')
      opts.ciphers = conn.cipherList
    return opts
  } catch (e) {
    Log.log('WS - TLS setup error, falling back to plain ws: ' + e)
    return null
  }
}

function normalizeIp(ip: string): string {
  // strip IPv4-mapped IPv6 prefix so ipAddresses can list plain IPv4
  return ip.replace(/^::ffff:/, '')
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export default WsServer
