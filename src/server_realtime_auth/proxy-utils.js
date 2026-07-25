/*
 * Reverse proxy helpers for JSON SCADA.
 * {json:scada} - Copyright (c) 2020-2024 - Ricardo L. Olsen
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

'use strict'

const {
  legacyCreateProxyMiddleware: createProxyMiddleware,
  fixRequestBody,
} = require('http-proxy-middleware')
const jwt = require('jsonwebtoken')
const config = require('./app/config/auth.config.js')
const Log = require('./simple-logger')

const NODERED_MOUNT_PATH = '/nodered'
const NODERED_DEFAULT_SERVER = 'http://127.0.0.1:1880/nodered/'

// Express strips the mount path from req.url, while http upgrade requests (websockets)
// never go through express and keep the full url. Matching on originalUrl when available
// lets the same middleware filter both cases.
function mountPathFilter(mountPath) {
  return function (_pathname, req) {
    const url = (req?.originalUrl || req?.url || '').split('?')[0]
    return url === mountPath || url.startsWith(mountPath + '/')
  }
}

// Token check for websocket upgrades, that do not pass through the express middlewares.
function checkUpgradeToken(req) {
  let token = req.headers['x-access-token']
  if (!token && typeof req.headers?.cookie === 'string') {
    req.headers.cookie.split(';').forEach((cookie) => {
      const sep = cookie.indexOf('=')
      if (sep === -1) return
      if (cookie.slice(0, sep).trim() === 'x-access-token')
        token = decodeURIComponent(cookie.slice(sep + 1).trim())
    })
  }
  if (!token) return false

  try {
    return jwt.verify(token, config.secret)
  } catch (err) {
    return false
  }
}

// Reverse proxy for the Node-RED editor mounted on /nodered.
// Node-RED serves itself under a prefix of its own (httpAdminRoot, '/nodered/' by default),
// so the path of the target url replaces the mount path on the forwarded request.
// Websocket upgrades (<httpAdminRoot>/comms) are handled by attachNoderedUpgrade.
function createNoderedProxy(noderedServer) {
  let target
  try {
    target = new URL(noderedServer)
  } catch (err) {
    Log.log(
      'Invalid Node-RED server url: ' +
        noderedServer +
        ', using ' +
        NODERED_DEFAULT_SERVER
    )
    target = new URL(NODERED_DEFAULT_SERVER)
  }

  const basePath = target.pathname.replace(/\/+$/, '')
  Log.log(
    'Node-RED reverse proxy on ' +
      NODERED_MOUNT_PATH +
      ' -> ' +
      target.origin +
      basePath +
      '/'
  )

  return createProxyMiddleware({
    target: target.origin,
    changeOrigin: true,
    ws: false, // upgrades are handled by attachNoderedUpgrade, to keep them authenticated
    pathFilter: mountPathFilter(NODERED_MOUNT_PATH),
    ...(basePath === NODERED_MOUNT_PATH
      ? {}
      : { pathRewrite: { ['^' + NODERED_MOUNT_PATH]: basePath } }),
    on: {
      // the json/urlencoded body parsers run before this proxy, restore the consumed body
      proxyReq: fixRequestBody,
      error: (err, req, resOrSocket) => {
        Log.log('Node-RED proxy error: ' + err.message)
        if (typeof resOrSocket?.writeHead === 'function') {
          if (!resOrSocket.headersSent) {
            resOrSocket.writeHead(502, { 'Content-Type': 'text/plain' })
            resOrSocket.end('Node-RED server not available')
          }
        } else resOrSocket?.destroy?.()
      },
    },
  })
}

// Proxy the websocket upgrades of the Node-RED editor (<httpAdminRoot>/comms).
// Upgrade requests bypass express, so the token is verified here.
function attachNoderedUpgrade(httpServer, noderedProxy) {
  const isNoderedRequest = mountPathFilter(NODERED_MOUNT_PATH)

  httpServer.on('upgrade', (req, socket, head) => {
    if (!isNoderedRequest(null, req)) return

    const decoded = checkUpgradeToken(req)
    if (decoded === false) {
      Log.log('Node-RED websocket denied (absent or invalid access token)')
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (decoded?.username) req.headers['X-WEBAUTH-USER'] = decoded.username

    noderedProxy.upgrade(req, socket, head)
  })
}

module.exports = {
  NODERED_MOUNT_PATH,
  NODERED_DEFAULT_SERVER,
  mountPathFilter,
  createNoderedProxy,
  attachNoderedUpgrade,
}
