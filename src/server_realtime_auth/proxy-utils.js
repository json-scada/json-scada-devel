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
  createProxyMiddleware,
  fixRequestBody,
} = require('http-proxy-middleware')
const jwt = require('jsonwebtoken')
const config = require('./app/config/auth.config.js')
const Log = require('./simple-logger')

const NODERED_MOUNT_PATH = '/nodered'
const NODERED_DEFAULT_SERVER = 'http://127.0.0.1:1880/nodered/'
const LOGIO_MOUNT_PATH = '/log-io'
const LOGIO_DEFAULT_SERVER = 'http://127.0.0.1:6688'

// Express strips the mount path from req.url when a middleware is mounted with
// app.use('/nodered', ...), so a proxy mounted that way would forward '/' instead of
// '/nodered/' and the target answers 404. http-proxy-middleware did this restore itself
// while legacyCreateProxyMiddleware existed (req.url = req.originalUrl || req.url); v4
// removed both the legacy factory and that patch, so it has to be done here.
// Websocket upgrades never go through express: they are handed to proxy.upgrade() with
// the full url already in req.url and no originalUrl, so they are left untouched.
function withMountedUrl(proxy) {
  const middleware = function (req, res, next) {
    if (req.originalUrl) req.url = req.originalUrl
    return proxy(req, res, next)
  }
  if (typeof proxy.upgrade === 'function')
    middleware.upgrade = proxy.upgrade.bind(proxy)
  return middleware
}

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

  return withMountedUrl(
    createProxyMiddleware({
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
  )
}

// Reverse proxy for the websocket transport of the log.io ui, mounted on /log-io.
// The ui derives its socket.io path from the page mount point, so it connects to
// /log-io/socket.io while the log.io server serves socket.io at /socket.io: the mount
// path is stripped from the forwarded request, just like the express /log-io proxy does
// for the http (polling) requests.
// Only the upgrades reach this proxy, through attachLogioUpgrade.
function createLogioProxy(logioServer) {
  let target
  try {
    target = new URL(logioServer)
  } catch (err) {
    Log.log(
      'Invalid log.io server url: ' +
        logioServer +
        ', using ' +
        LOGIO_DEFAULT_SERVER
    )
    target = new URL(LOGIO_DEFAULT_SERVER)
  }

  Log.log(
    'Log.io websocket reverse proxy on ' +
      LOGIO_MOUNT_PATH +
      ' -> ' +
      target.origin +
      '/'
  )

  return withMountedUrl(
    createProxyMiddleware({
      target: target.origin,
      changeOrigin: true,
      ws: false, // upgrades are handled by attachLogioUpgrade, to keep them authenticated
      pathFilter: mountPathFilter(LOGIO_MOUNT_PATH), // do not grab upgrades of other proxies
      pathRewrite: { ['^' + LOGIO_MOUNT_PATH]: '' },
      on: {
        // the json/urlencoded body parsers run before this proxy, restore the consumed body
        proxyReq: fixRequestBody,
        error: (err, req, resOrSocket) => {
          Log.log('Log.io proxy error: ' + err.message)
          if (typeof resOrSocket?.writeHead === 'function') {
            if (!resOrSocket.headersSent) {
              resOrSocket.writeHead(502, { 'Content-Type': 'text/plain' })
              resOrSocket.end('Log.io server not available')
            }
          } else resOrSocket?.destroy?.()
        },
      },
    })
  )
}

// Proxy the websocket upgrades of a mounted reverse proxy.
// Upgrade requests never reach the express middlewares (so verifyToken cannot run on
// them), they are handled on the raw http server and the token is verified here instead.
function attachProxyUpgrade(httpServer, proxy, mountPath, label) {
  const isProxiedRequest = mountPathFilter(mountPath)

  httpServer.on('upgrade', (req, socket, head) => {
    if (!isProxiedRequest(null, req)) return

    const decoded = checkUpgradeToken(req)
    if (decoded === false) {
      Log.log(label + ' websocket denied (absent or invalid access token)')
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    if (decoded?.username) req.headers['X-WEBAUTH-USER'] = decoded.username

    proxy.upgrade(req, socket, head)
  })
}

// Websocket upgrades of the Node-RED editor (<httpAdminRoot>/comms).
function attachNoderedUpgrade(httpServer, noderedProxy) {
  attachProxyUpgrade(httpServer, noderedProxy, NODERED_MOUNT_PATH, 'Node-RED')
}

// Websocket upgrades of the log.io ui (/log-io/socket.io).
function attachLogioUpgrade(httpServer, logioProxy) {
  attachProxyUpgrade(httpServer, logioProxy, LOGIO_MOUNT_PATH, 'Log.io')
}

module.exports = {
  NODERED_MOUNT_PATH,
  NODERED_DEFAULT_SERVER,
  LOGIO_MOUNT_PATH,
  LOGIO_DEFAULT_SERVER,
  mountPathFilter,
  withMountedUrl,
  createNoderedProxy,
  attachNoderedUpgrade,
  createLogioProxy,
  attachLogioUpgrade,
}
