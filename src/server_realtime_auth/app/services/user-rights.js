/*
 * Effective rights of a user, combined from all the roles it holds.
 * {json:scada} - Copyright (c) 2020-2025 - Ricardo L. Olsen
 *
 * The token only identifies the user (id, username, token version, token id).
 * Rights are read from the database (cached for a few seconds) on every request,
 * so a deleted user, a changed role, a password change (token version) or a
 * sign-out (revoked token id) take effect without waiting for the token to expire.
 */

'use strict'

const Log = require('../../simple-logger')
const db = require('../models')

const CACHE_TTL_MS = 10000
const CACHE_MAX_ENTRIES = 5000
const REVOKED_REFRESH_MS = 10000
const COLL_REVOKED = 'revokedTokens'

// thrown when the rights cannot be read (database trouble) and nothing is cached:
// callers answer "service unavailable", never "access denied"
class RightsUnavailableError extends Error {
  constructor(msg) {
    super(msg || 'User rights unavailable (database not available)')
    this.name = 'RightsUnavailableError'
  }
}

const cache = new Map() // user id -> { t, rights, tokenVersion }

// set by the server's mongodb watcher: while the database is known to be down a
// lookup would only wait for the driver timeout, so cached rights (or an
// "unavailable" answer) are given at once
let databaseHealthy = true
function setDatabaseHealthy(healthy) {
  databaseHealthy = !!healthy
}
const inflight = new Map() // user id -> pending lookup, shared by concurrent requests

// Combines the rights of the (populated) roles of a user.
function combineRights(roles) {
  const rights = {
    isAdmin: false,
    changePassword: false,
    sendCommands: false,
    enterAnnotations: false,
    enterNotes: false,
    enterManuals: false,
    enterLimits: false,
    substituteValues: false,
    ackEvents: false,
    ackAlarms: false,
    disableAlarms: false,
    cimEngineering: false,
    group1List: [],
    group1CommandList: [],
    displayList: [],
    maxSessionDays: 0.0,
  }
  const authorities = []
  const flags = [
    'isAdmin',
    'changePassword',
    'sendCommands',
    'enterAnnotations',
    'enterNotes',
    'enterManuals',
    'enterLimits',
    'substituteValues',
    'ackEvents',
    'ackAlarms',
    'disableAlarms',
    'cimEngineering',
  ]

  const list = roles || []
  for (let i = 0; i < list.length; i++) {
    const role = list[i]
    if (!role) continue
    authorities.push(role.name)
    for (const f of flags) rights[f] = rights[f] || !!role[f]

    // an empty group1 list means unrestricted: it wins over any restricted role
    const g1 = Array.from(role.group1List || [])
    rights.group1List =
      i > 0 && (rights.group1List.length === 0 || g1.length === 0)
        ? []
        : rights.group1List.concat(g1)
    rights.group1CommandList = rights.group1CommandList.concat(
      Array.from(role.group1CommandList || [])
    )
    rights.displayList = rights.displayList.concat(
      Array.from(role.displayList || [])
    )
    if (role.maxSessionDays > rights.maxSessionDays)
      rights.maxSessionDays = role.maxSessionDays
  }
  return { rights, authorities }
}

// Reads a user and its rights; null when the user does not exist, throws on error.
async function loadEntry(key) {
  let p = inflight.get(key)
  if (!p) {
    p = (async () => {
      // always the primary (also with JS_SERVER_REALTIME_AUTH_READ_FROM_SECONDARY):
      // a removed right or a password change must not wait for replication
      const user = await db.user
        .findById(key)
        .read('primary')
        .populate({
          path: 'roles',
          select: '-__v',
          options: { readPreference: 'primary' },
        })
        .exec()
      if (!user) {
        cache.delete(key)
        return null
      }
      const entry = {
        t: Date.now(),
        rights: combineRights(user.roles).rights,
        tokenVersion: Number(user.tokenVersion) || 0,
      }
      if (cache.size >= CACHE_MAX_ENTRIES) cache.clear()
      cache.set(key, entry)
      return entry
    })().finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return p
}

// Rights of the user a decoded token belongs to, or null when the user does not
// exist or the token is no longer valid (revoked, or older than the last password
// change). Throws RightsUnavailableError when the database cannot be read and
// nothing is cached. `fresh` bypasses the cache (commands and admin actions).
async function getCurrentRights(token, opts = {}) {
  if (!token || typeof token !== 'object' || !token.id) return null
  if (token.jti && revoked.has(token.jti)) return null
  const key = String(token.id)
  const hit = cache.get(key)

  let entry = null
  if (hit && !opts.fresh && Date.now() - hit.t < CACHE_TTL_MS) entry = hit
  else if (!databaseHealthy) {
    if (!hit) throw new RightsUnavailableError()
    entry = hit
  } else {
    try {
      entry = await loadEntry(key)
    } catch (err) {
      if (err?.name === 'CastError') return null // not a valid user id
      Log.log('getCurrentRights: ' + err)
      // database trouble: keep serving the last known rights rather than fail open
      if (!hit) throw new RightsUnavailableError()
      entry = hit
    }
  }
  if (!entry) return null
  if ((Number(token.tv) || 0) !== entry.tokenVersion) return null
  return entry.rights
}

// call after any change of users or roles made by this server
function invalidate() {
  cache.clear()
}

// Can these rights command a point of the given group1?
// A role with a command list restricts commands to the listed groups; a role
// restricted to some stations (group1List) can only command those stations
// too: both lists apply when both are given. Special '$$' commands (no point,
// no station) need the '$$' entry in a command list when the user is
// restricted by either list.
function canCommandGroup(rights, group1) {
  if (!rights || !rights.sendCommands) return false
  const cmdList = rights.group1CommandList || []
  const viewList = rights.group1List || []
  if (group1 === '$$')
    return (cmdList.length === 0 && viewList.length === 0) || cmdList.includes('$$')
  if (cmdList.length > 0 && !cmdList.includes(group1)) return false
  if (viewList.length > 0 && !viewList.includes(group1)) return false
  return true
}

// ---------------------------------------------------------------------------
// Token invalidation
// ---------------------------------------------------------------------------

// ids (jti) of signed-out tokens that did not expire yet; also stored in the
// database (TTL index) so that other server instances and restarts know them
let revoked = new Set()
let revokedIndexReady = false

function nativeDb() {
  const conn = db.mongoose.connection
  return conn.readyState === 1 ? conn.db : null
}

async function ensureRevokedIndex(mdb) {
  if (revokedIndexReady) return
  await mdb
    .collection(COLL_REVOKED)
    .createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 })
  revokedIndexReady = true
}

async function refreshRevoked() {
  const mdb = nativeDb()
  if (!mdb) return
  try {
    const docs = await mdb
      .collection(COLL_REVOKED)
      .find(
        { expireAt: { $gt: new Date() } },
        { projection: { _id: 1 }, readPreference: 'primary' }
      )
      .toArray()
    const next = new Set(docs.map((d) => d._id))
    for (const j of revoked) if (pendingRevoked.has(j)) next.add(j)
    revoked = next
  } catch (err) {
    Log.log('refreshRevoked: ' + err.message)
  }
}
setInterval(refreshRevoked, REVOKED_REFRESH_MS).unref()

const pendingRevoked = new Set() // revoked here, not yet stored

// Sign-out: the token stops being accepted even if a copy of it is kept.
async function revokeToken(token) {
  if (!token?.jti) return
  revoked.add(token.jti)
  pendingRevoked.add(token.jti)
  const mdb = nativeDb()
  if (!mdb) return
  try {
    await ensureRevokedIndex(mdb)
    await mdb.collection(COLL_REVOKED).updateOne(
      { _id: token.jti },
      {
        $set: {
          expireAt: new Date(
            (Number(token.exp) || Date.now() / 1000 + 86400) * 1000
          ),
        },
      },
      { upsert: true }
    )
    pendingRevoked.delete(token.jti)
  } catch (err) {
    Log.log('revokeToken: ' + err.message)
  }
}

// Password change: every token issued before it stops being accepted.
async function bumpTokenVersion(userId) {
  await db.user.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } }).exec()
  invalidate()
}

module.exports = {
  RightsUnavailableError,
  combineRights,
  getCurrentRights,
  invalidate,
  canCommandGroup,
  revokeToken,
  bumpTokenVersion,
  setDatabaseHealthy,
}
