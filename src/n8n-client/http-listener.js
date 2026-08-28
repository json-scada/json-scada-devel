/*
 * {json:scada} - Copyright (c) 2020-2024 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * Inbound HTTP listener: lets n8n workflows push telemetry-style values into
 * tags owned by the N8N connection (auto-created when enabled) and, optionally,
 * issue commands to points via the commandsQueue (double opt-in, audited).
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

'use strict'

const http = require('http')
const https = require('https')
const fs = require('fs')
const express = require('express')
const { Double } = require('mongodb')
const Log = require('./simple-logger')
const AppDefs = require('./app-defs')
const Tags = require('./tags-creation')

// ctx provides live references maintained by index.js:
// {
//   configObj, connection (live object), collections: {rt, cmd, userActions},
//   isActive: () => bool, allocKey: () => number, listCreatedTags: Set,
//   stats (mutable object), bindAddress, bindPort, allowedIps: [],
//   basicUser, basicPass, enableDirectCommands, tls: {cert,key,ca}|null
// }
function StartListener(ctx) {
  const app = express()
  app.use(express.json({ limit: '16mb' }))

  // source IP allowlist
  app.use((req, res, next) => {
    if (ctx.allowedIps && ctx.allowedIps.length > 0) {
      const ip = clientIp(req)
      if (!ctx.allowedIps.includes(ip)) {
        Log.log('Listener - Rejected source IP ' + ip, Log.levelDetailed)
        return res.status(403).json({ error: 'source IP not allowed' })
      }
    }
    next()
  })

  // Basic auth (mandatory unless no username configured AND global NOAUTH)
  app.use((req, res, next) => {
    if (req.path === '/n8n/health') return next() // health is public
    if (!ctx.basicUser || ctx.basicUser === '') {
      // no credentials configured -> refuse all data/command calls
      return res
        .status(401)
        .json({ error: 'listener credentials not configured' })
    }
    const hdr = req.headers.authorization || ''
    if (!hdr.startsWith('Basic ')) {
      res.set('WWW-Authenticate', 'Basic realm="json-scada-n8n"')
      return res.status(401).json({ error: 'missing Basic authorization' })
    }
    const creds = Buffer.from(hdr.slice(6), 'base64').toString('utf8')
    const idx = creds.indexOf(':')
    const user = idx >= 0 ? creds.slice(0, idx) : creds
    const pass = idx >= 0 ? creds.slice(idx + 1) : ''
    if (user !== ctx.basicUser || pass !== ctx.basicPass) {
      return res.status(401).json({ error: 'invalid credentials' })
    }
    next()
  })

  // health/liveness + stats
  app.get('/n8n/health', (req, res) => {
    res.json({
      app: AppDefs.NAME,
      version: AppDefs.VERSION,
      active: ctx.isActive(),
      connection: ctx.connection?.protocolConnectionNumber,
      connectionName: ctx.connection?.name,
      stats: ctx.stats,
    })
  })

  // inbound value updates -> update/create supervised tags owned by this connection
  app.post('/n8n/updates', async (req, res) => {
    if (!ctx.isActive())
      return res.status(503).json({ error: 'driver instance not active' })
    const points = Array.isArray(req.body?.points)
      ? req.body.points
      : Array.isArray(req.body)
        ? req.body
        : null
    if (!points)
      return res.status(400).json({ error: 'expected {points:[...]}' })

    const connNumber = ctx.connection.protocolConnectionNumber
    let updated = 0
    let created = 0
    const errors = []
    for (const p of points) {
      if (!p || typeof p.tag !== 'string' || p.tag === '') {
        errors.push({ point: p, error: 'missing tag' })
        continue
      }
      try {
        if (ctx.autoCreateTags && !ctx.listCreatedTags.has(p.tag)) {
          const existing = await ctx.collections.rt
            .find({
              protocolSourceConnectionNumber: connNumber,
              protocolSourceObjectAddress: p.tag,
            })
            .limit(1)
            .toArray()
          if (existing.length === 0) {
            const key = ctx.allocKey()
            const newTag = Tags.NewTag(p, connNumber, key, ctx.connection.name)
            const ins = await ctx.collections.rt.insertOne(newTag)
            if (ins.acknowledged) {
              ctx.listCreatedTags.add(p.tag)
              created++
            }
          } else {
            ctx.listCreatedTags.add(p.tag)
          }
        }
        const upd = Tags.SourceDataUpdate(p, connNumber)
        const r = await ctx.collections.rt.updateOne(
          {
            protocolSourceConnectionNumber: connNumber,
            protocolSourceObjectAddress: p.tag,
          },
          { $set: { sourceDataUpdate: upd } }
        )
        if (r.matchedCount > 0) updated++
        else errors.push({ tag: p.tag, error: 'tag not found (autoCreate off?)' })
      } catch (e) {
        errors.push({ tag: p.tag, error: e.message })
      }
    }
    ctx.stats.inboundUpdates += updated
    res.json({ updated, created, errors })
  })

  // inbound direct command -> insert into commandsQueue (double opt-in)
  app.post('/n8n/commands', async (req, res) => {
    if (!ctx.isActive())
      return res.status(503).json({ error: 'driver instance not active' })
    if (!ctx.enableDirectCommands)
      return res.status(403).json({
        error:
          'direct commands disabled (require commandsEnabled and options.enableDirectCommands)',
      })
    const tag = req.body?.tag
    if (typeof tag !== 'string' || tag === '')
      return res.status(400).json({ error: 'missing tag' })
    let cmdVal = req.body?.value
    if (cmdVal === undefined || cmdVal === null)
      return res.status(400).json({ error: 'missing value' })

    try {
      // resolve the command point
      const point = await ctx.collections.rt.findOne({ tag: tag })
      if (!point)
        return res.status(404).json({ error: 'tag not found: ' + tag })
      if (point.origin !== 'command')
        return res
          .status(400)
          .json({ error: 'tag is not a command point: ' + tag })

      const numVal =
        typeof cmdVal === 'boolean' ? (cmdVal ? 1 : 0) : parseFloat(cmdVal)
      const cmdValStr = String(cmdVal)

      // build addressing preserving numeric vs string convention
      let addressing
      if (
        (point.protocolSourceCommonAddress != '' &&
          isNaN(point.protocolSourceCommonAddress)) ||
        isNaN(point.protocolSourceObjectAddress) ||
        isNaN(point.protocolSourceASDU)
      ) {
        addressing = {
          protocolSourceCommonAddress: point.protocolSourceCommonAddress,
          protocolSourceObjectAddress: point.protocolSourceObjectAddress,
          protocolSourceASDU: point.protocolSourceASDU,
        }
      } else {
        addressing = {
          protocolSourceCommonAddress: new Double(
            point.protocolSourceCommonAddress
          ),
          protocolSourceObjectAddress: new Double(
            point.protocolSourceObjectAddress
          ),
          protocolSourceASDU: new Double(point.protocolSourceASDU),
        }
      }

      const originator = 'N8N:' + (ctx.connection.name || '')
      const ins = await ctx.collections.cmd.insertOne({
        protocolSourceConnectionNumber: new Double(
          point.protocolSourceConnectionNumber
        ),
        ...addressing,
        protocolSourceCommandDuration: new Double(
          point.protocolSourceCommandDuration || 0
        ),
        protocolSourceCommandUseSBO: point.protocolSourceCommandUseSBO || false,
        pointKey: new Double(point._id),
        tag: point.tag,
        timeTag: new Date(),
        value: new Double(numVal),
        valueString: cmdValStr,
        originatorUserName: originator,
        originatorIpAddress: clientIp(req),
      })
      if (!ins.acknowledged)
        return res.status(500).json({ error: 'could not queue command' })

      // audit trail
      try {
        await ctx.collections.userActions.insertOne({
          username: originator,
          properties: { command: tag, value: cmdVal },
          action: 'issue command',
          timeTag: new Date(),
        })
      } catch (e) {}

      ctx.stats.inboundCommands++
      res.json({ queued: true, tag: tag, value: cmdVal })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })

  const server = ctx.tls
    ? https.createServer(
        { key: ctx.tls.key, cert: ctx.tls.cert, ca: ctx.tls.ca },
        app
      )
    : http.createServer(app)

  server.on('error', (e) => {
    Log.log('Listener - Server error: ' + e.message)
  })
  server.listen(ctx.bindPort, ctx.bindAddress, () => {
    Log.log(
      'Listener - ' +
        (ctx.tls ? 'https' : 'http') +
        ' listening on ' +
        ctx.bindAddress +
        ':' +
        ctx.bindPort
    )
  })
  return server
}

function clientIp(req) {
  return (
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    ''
  )
}

module.exports = { StartListener }
