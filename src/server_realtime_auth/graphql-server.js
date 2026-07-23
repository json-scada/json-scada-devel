/*
 * GraphQL API server for JSON SCADA - mounted at /apollo.
 * Provides queries and mutations with functionality similar to the OPC-like /Invoke API:
 * realtime data, alarms, SOE events, historical data, commands, acknowledgments,
 * point property updates, user/roles/protocol configuration and audit trail.
 * User rights (RBAC) are enforced the same way as in the /Invoke API.
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

'use strict'

const { ApolloServer } = require('@apollo/server')
const { expressMiddleware } = require('@as-integrations/express5')
const { GraphQLError, GraphQLScalarType, Kind } = require('graphql')
const cors = require('cors')
const express = require('express')
const { ObjectId, Double } = require('mongodb')
const { Pool } = require('pg')
const { authJwt } = require('./app/middlewares')
const { canSendCommands, canSendCommandTo } = require('./app/middlewares/authJwt.js')
const UserActionsQueue = require('./userActionsQueue')
const Log = require('./simple-logger')

const API_AP = process.env.JS_GRAPHQL_AP || '/apollo'
const COLL_REALTIME = 'realtimeData'
const COLL_SOE = 'soeData'
const COLL_COMMANDS = 'commandsQueue'
const beepPointKey = -1
const EventsRemoveGuardSeconds = 20
const DoInsertCommandAsSOE = true
const CommandSentAsSOESymbol = '⚙️➡️'
const MaxQueryLimit = 20000
const MaxHistoryLimit = 50000

let db = null // mongoose models (see app/models)
let AUTH = true // authentication/RBAC enabled?
let pgPool = null // postgresql connection pool (for historical data)

// ----------------------------------------------------------------------------
// Custom scalars
// ----------------------------------------------------------------------------

const DateTime = new GraphQLScalarType({
  name: 'DateTime',
  description: 'Date/time value serialized as an ISO-8601 string.',
  serialize(value) {
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'number') return new Date(value).toISOString()
    if (typeof value === 'string') {
      const d = new Date(value)
      if (!isNaN(d.getTime())) return d.toISOString()
    }
    return null
  },
  parseValue(value) {
    const d = new Date(value)
    if (isNaN(d.getTime()))
      throw new GraphQLError('DateTime must be a valid date string or epoch.', {
        extensions: { code: 'BAD_USER_INPUT' },
      })
    return d
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT) {
      const d = new Date(ast.kind === Kind.INT ? parseInt(ast.value) : ast.value)
      if (!isNaN(d.getTime())) return d
    }
    throw new GraphQLError('DateTime must be a valid date string or epoch.', {
      extensions: { code: 'BAD_USER_INPUT' },
    })
  },
})

function parseJSONLiteral(ast) {
  switch (ast.kind) {
    case Kind.STRING:
      return ast.value
    case Kind.BOOLEAN:
      return ast.value
    case Kind.INT:
      return parseInt(ast.value, 10)
    case Kind.FLOAT:
      return parseFloat(ast.value)
    case Kind.OBJECT: {
      const value = Object.create(null)
      ast.fields.forEach((field) => {
        value[field.name.value] = parseJSONLiteral(field.value)
      })
      return value
    }
    case Kind.LIST:
      return ast.values.map(parseJSONLiteral)
    case Kind.NULL:
      return null
    default:
      return undefined
  }
}

const JSONValue = new GraphQLScalarType({
  name: 'JSONValue',
  description: 'Arbitrary JSON value (object, array, string, number, boolean or null).',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: parseJSONLiteral,
})

// ----------------------------------------------------------------------------
// Schema
// ----------------------------------------------------------------------------

const typeDefs = `#graphql
  scalar DateTime
  scalar JSONValue

  type Query {
    "Server information and database connectivity status."
    serverInfo: ServerInfo!
    "Information about the authenticated user and its combined role rights."
    me: CurrentUser!

    "Flexible query of realtime points. All filter conditions are combined with AND."
    tags(
      filter: TagFilter
      limit: Int = 1000
      skip: Int = 0
      sortBy: String = "tag"
      sortDesc: Boolean = false
    ): [Tag!]!
    "Count of realtime points matching a filter."
    tagsCount(filter: TagFilter): Int!
    "Get one point by its string tag name."
    tag(tag: String!): Tag
    "Get one point by its numeric point key (_id)."
    tagById(id: Float!): Tag
    "List of distinct group1 (station) names with point counts."
    groups1: [GroupCount!]!
    "List of distinct group2 (bay) names with point counts, optionally filtered by group1."
    groups2(group1: String): [GroupCount!]!
    "Currently alarmed or out-of-normal points (like the persistentAlarms filter of the /Invoke API)."
    activeAlarms(group1: String, group2: String, limit: Int = 1000): [Tag!]!

    "Query sequence of events (SOE) data. Defaults to the last hour when no time range is given."
    soeEvents(filter: SoeFilter, limit: Int = 1000, ascending: Boolean = false): [SoeEvent!]!

    "Query historical values (PostgreSQL/TimescaleDB 'hist' table) for a list of tags."
    historicalData(
      tags: [String!]!
      timeBegin: DateTime
      timeEnd: DateTime
      limit: Int = 10000
    ): [TagHistory!]!

    "Check status of a previously issued command using the handle returned by the issueCommand mutation."
    commandStatus(commandHandle: ID!): CommandStatus

    "Audit trail of user actions (admin only)."
    userActions(filter: UserActionFilter, limit: Int = 1000, skip: Int = 0): [UserAction!]!

    "List users (admin only)."
    users: [User!]!
    "List roles (admin only)."
    roles: [Role!]!
    "Global system settings (admin only)."
    systemSettings: SystemSettings

    "List protocol driver instances."
    protocolDriverInstances: [ProtocolDriverInstance!]!
    "List protocol connections (credentials/certificates are never exposed)."
    protocolConnections: [ProtocolConnection!]!

    # ---- legacy query names kept for backward compatibility ----
    "Deprecated: use users. (admin only)"
    getUsers: [User!]!
    "Deprecated: use users/userByName. (admin only)"
    getUserByName(username: String!): User
    "Deprecated: use tags(filter: { group1: ... })."
    getTagsByGroup1(group1: String!): [Tag!]!
    "Deprecated: use tags(filter: { tags: [...] })."
    getTags(tags: [String]!): [Tag!]!
    "Deprecated: use tag."
    getTag(tag: String!): Tag
    "Deprecated: use protocolDriverInstances."
    getProtocolDriverInstances: [ProtocolDriverInstance!]!
    "Deprecated: use protocolConnections."
    getProtocolConnections: [ProtocolConnection!]!
  }

  type Mutation {
    """
    Issue a command (control) to a command point, by numeric point key or tag name.
    Requires the sendCommands right and permission for the point's group1 (station).
    Use the returned commandHandle with the commandStatus query to track acknowledgment.
    Command tags beginning with '$$' are queued directly without a point lookup.
    """
    issueCommand(tagOrId: String!, value: Float, valueString: String): CommandResult!

    "Acknowledge or remove events from the SOE list. Requires the ackEvents right."
    ackEvents(action: EventAckAction!, tag: String, eventId: ID): ActionResult!

    "Acknowledge alarms or silence beep. Requires the ackAlarms right."
    ackAlarms(action: AlarmAckAction!, tagOrId: String): ActionResult!

    """
    Update point properties (annotation, notes, limits, alarm disabling, value substitution).
    Each property requires its respective user right (enterAnnotations, enterNotes,
    enterLimits, disableAlarms, substituteValues).
    """
    updateTagProperties(tagOrId: String!, properties: TagPropertiesInput!): ActionResult!
  }

  enum EventAckAction {
    ACK_ONE_EVENT
    ACK_POINT_EVENTS
    ACK_ALL_EVENTS
    REMOVE_ONE_EVENT
    REMOVE_POINT_EVENTS
    REMOVE_ALL_EVENTS
  }

  enum AlarmAckAction {
    ACK_ONE_ALARM
    ACK_ALL_ALARMS
    SILENCE_BEEP
  }

  enum CommandAckStatus {
    PENDING
    ACK_OK
    ACK_FAIL
    CANCELLED
  }

  input TagFilter {
    "Match a list of tag names."
    tags: [String!]
    "Match a list of numeric point keys."
    ids: [Float!]
    group1: String
    group2: String
    group3: String
    "Point type: digital, analog, string or json."
    type: String
    "Point origin: supervised, command, calculated or manual."
    origin: String
    alarmed: Boolean
    alarmDisabled: Boolean
    invalid: Boolean
    frozen: Boolean
    alerted: Boolean
    isEvent: Boolean
    substituted: Boolean
    commandBlocked: Boolean
    "Case-insensitive substring match on the tag name."
    tagContains: String
    "Case-insensitive substring match on the description."
    descriptionContains: String
  }

  input SoeFilter {
    "Restrict to a list of tag names."
    tags: [String!]
    "Restrict to a list of group1 (station) names."
    group1List: [String!]
    "Only events with priority less than or equal to this value."
    priorityLte: Float
    timeBegin: DateTime
    timeEnd: DateTime
    "Filter/sort by source timestamp instead of server timestamp."
    useSourceTime: Boolean
    "Group events by tag returning the latest event and a count per tag."
    aggregate: Boolean
    "Include events removed from the list (ack = 2)."
    includeRemoved: Boolean
  }

  input UserActionFilter {
    username: String
    "Case-insensitive substring match on the action name."
    actionContains: String
    tag: String
    timeBegin: DateTime
    timeEnd: DateTime
  }

  input TagPropertiesInput {
    annotation: String
    notes: String
    loLimit: Float
    hiLimit: Float
    hysteresis: Float
    alarmDisabled: Boolean
    "Set together with newValue to substitute (manually enter) the point value."
    substituted: Boolean
    newValue: Float
  }

  type ServerInfo {
    name: String!
    version: String!
    timestamp: DateTime!
    authenticationEnabled: Boolean!
    mongoConnected: Boolean!
  }

  type CurrentUser {
    username: String!
    rights: UserRights
  }

  type UserRights {
    isAdmin: Boolean
    changePassword: Boolean
    sendCommands: Boolean
    enterAnnotations: Boolean
    enterNotes: Boolean
    enterManuals: Boolean
    enterLimits: Boolean
    substituteValues: Boolean
    ackEvents: Boolean
    ackAlarms: Boolean
    disableAlarms: Boolean
    group1List: [String]
    group1CommandList: [String]
    displayList: [String]
    maxSessionDays: Float
  }

  type GroupCount {
    name: String!
    count: Int!
  }

  type SourceDataUpdate {
    valueAtSource: Float
    valueStringAtSource: String
    valueJsonAtSource: JSONValue
    asduAtSource: String
    causeOfTransmissionAtSource: String
    timeTagAtSource: Float
    timeTagAtSourceOk: Boolean
    timeTag: Float
    notTopicalAtSource: Boolean
    invalidAtSource: Boolean
    overflowAtSource: Boolean
    blockedAtSource: Boolean
    substitutedAtSource: Boolean
    originator: String
  }

  type Tag {
    _id: Float!
    tag: String!
    value: Float
    valueString: String
    valueJson: JSONValue
    valueDefault: Float
    alarmDisabled: Boolean
    alarmRange: Float
    alarmState: Float
    alarmed: Boolean
    alerted: Boolean
    alertState: String
    annotation: String
    commandBlocked: Boolean
    commandOfSupervised: Float
    commissioningRemarks: String
    description: String
    eventTextFalse: String
    eventTextTrue: String
    formula: Float
    frozen: Boolean
    frozenDetectTimeout: Float
    group1: String
    group2: String
    group3: String
    hihihiLimit: Float
    hihiLimit: Float
    hiLimit: Float
    historianDeadBand: Float
    historianPeriod: Float
    historianLastValue: Float
    hysteresis: Float
    invalid: Boolean
    invalidDetectTimeout: Float
    isEvent: Boolean
    kconv1: Float
    kconv2: Float
    location: JSONValue
    loLimit: Float
    loloLimit: Float
    lololoLimit: Float
    notes: String
    origin: String
    overflow: Boolean
    priority: Float
    protocolSourceConnectionNumber: Float
    protocolSourceObjectAddress: String
    stateTextFalse: String
    stateTextTrue: String
    substituted: Boolean
    supervisedOfCommand: Float
    timeTag: Float
    timeTagAlarm: Float
    timeTagAlertState: Float
    timeTagAtSource: Float
    timeTagAtSourceOk: Boolean
    transient: Boolean
    type: String
    ungroupedDescription: String
    unit: String
    updatesCnt: Float
    zeroDeadband: Float
    sourceDataUpdate: SourceDataUpdate
  }

  type SoeEvent {
    eventId: ID
    tag: String
    pointKey: Float
    group1: String
    description: String
    eventText: String
    invalid: Boolean
    priority: Float
    timeTag: DateTime
    timeTagAtSource: DateTime
    timeTagAtSourceOk: Boolean
    "0=unacknowledged, 1=acknowledged, 2=removed from list."
    ack: Int
    "Number of grouped events (only greater than 1 in aggregate mode)."
    count: Int
  }

  type TagHistory {
    tag: String!
    values: [HistoryPoint!]!
  }

  type HistoryPoint {
    value: Float
    "Value interpreted as boolean (for digital points)."
    valueBool: Boolean
    invalid: Boolean
    isDigital: Boolean
    timeTag: DateTime
    timeTagAtSource: DateTime
  }

  type CommandStatus {
    commandHandle: ID!
    tag: String
    value: Float
    valueString: String
    status: CommandAckStatus!
    timeTag: DateTime
    ackTimeTag: DateTime
    cancelReason: String
    originatorUserName: String
  }

  type CommandResult {
    ok: Boolean!
    error: String
    "Handle to track command acknowledgment via the commandStatus query."
    commandHandle: ID
  }

  type ActionResult {
    ok: Boolean!
    error: String
    "Number of documents matched/modified by the action, when applicable."
    matchedCount: Int
  }

  type UserAction {
    _id: ID!
    username: String
    action: String
    tag: String
    pointKey: Float
    properties: JSONValue
    timeTag: DateTime
  }

  type User {
    _id: ID!
    username: String!
    email: String
    roles: [ID!]
    roleDetails: [Role!]
    isLDAPUser: Boolean
    ldapDN: String
    lastLDAPSync: DateTime
  }

  type Role {
    _id: ID!
    name: String
    isAdmin: Boolean
    changePassword: Boolean
    sendCommands: Boolean
    enterAnnotations: Boolean
    enterNotes: Boolean
    enterManuals: Boolean
    enterLimits: Boolean
    substituteValues: Boolean
    ackEvents: Boolean
    ackAlarms: Boolean
    disableAlarms: Boolean
    group1List: [String]
    group1CommandList: [String]
    displayList: [String]
    maxSessionDays: Float
  }

  type SystemSettings {
    autoManageServices: Boolean
    autoRestartOnConnectionChange: Boolean
  }

  type ProtocolDriverInstance {
    _id: ID!
    protocolDriver: String!
    protocolDriverInstanceNumber: Float!
    enabled: Boolean
    logLevel: Float
    nodeNames: [String]
    keepProtocolRunningWhileInactive: Boolean
    activeNodeName: String
    activeNodeKeepAliveTimeTag: Float
    softwareVersion: String
    stats: JSONValue
  }

  type ProtocolConnection {
    _id: ID!
    protocolDriver: String!
    protocolDriverInstanceNumber: Float
    protocolConnectionNumber: Float
    name: String
    description: String
    enabled: Boolean
    commandsEnabled: Boolean
    ipAddressLocalBind: String
    ipAddresses: [String]
    topics: [String]
    endpointURLs: [String]
    autoCreateTags: Boolean
    timeoutMs: Float
    stats: JSONValue
  }
`

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function gqlError(message, code) {
  return new GraphQLError(message, { extensions: { code: code || 'INTERNAL_SERVER_ERROR' } })
}

function nativeDb() {
  const conn = db.mongoose.connection
  if (conn.readyState !== 1 || !conn.db)
    throw gqlError('Database disconnected!', 'SERVICE_UNAVAILABLE')
  return conn.db
}

function buildContext(req) {
  let token = false,
    username = 'unknown',
    rights = null
  if (AUTH) {
    token = authJwt.checkToken(req)
    if (token !== false) {
      if ('username' in token) username = token.username
      if ('rights' in token) rights = token.rights
    }
  }
  return { req, token, username, rights }
}

// group1 (station) access restriction filter for the realtime collection,
// beep and related internal points (_id -1/-2) are always accessible
function tagAccessFilter(ctx) {
  const g = ctx.rights?.group1List
  if (!AUTH || !g || g.length === 0) return null
  return { $or: [{ group1: { $in: g } }, { _id: { $in: [-1, -2] } }] }
}

// group1 access restriction filter for other collections (SOE, realtime updates)
function groupAccessFilter(ctx) {
  const g = ctx.rights?.group1List
  if (!AUTH || !g || g.length === 0) return null
  return { group1: { $in: g } }
}

function requireTokenRight(ctx, right, message) {
  if (!AUTH) return
  if (!ctx.rights?.[right]) {
    Log.log(`GraphQL: ${message} [${ctx.username}]`)
    throw gqlError(message, 'FORBIDDEN')
  }
}

// check right against the database (not just the token) like /Invoke does for commands
async function isAdminDb(ctx) {
  if (!AUTH) return true
  if (ctx.token === false) return false
  try {
    const user = await db.user.findById(ctx.token.id).exec()
    if (!user) return false
    const roles = await db.role.find({ _id: { $in: user.roles } }).exec()
    return roles.some((r) => r.isAdmin)
  } catch (err) {
    Log.log('GraphQL: ' + err.message)
    return false
  }
}

async function requireAdmin(ctx) {
  if (!(await isAdminDb(ctx))) throw gqlError('Requires admin rights!', 'FORBIDDEN')
}

function clampLimit(limit, max) {
  const m = max || MaxQueryLimit
  if (typeof limit !== 'number' || isNaN(limit) || limit <= 0) return 1000
  return Math.min(Math.floor(limit), m)
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function containsRegex(s) {
  return { $regex: escapeRegExp(s), $options: 'i' }
}

function buildTagQuery(ctx, filter) {
  const clauses = []
  const af = tagAccessFilter(ctx)
  if (af) clauses.push(af)
  if (filter) {
    if (filter.tags && filter.tags.length > 0) clauses.push({ tag: { $in: filter.tags } })
    if (filter.ids && filter.ids.length > 0) clauses.push({ _id: { $in: filter.ids } })
    for (const f of ['group1', 'group2', 'group3', 'type', 'origin'])
      if (typeof filter[f] === 'string' && filter[f] !== '') clauses.push({ [f]: filter[f] })
    for (const f of [
      'alarmed',
      'alarmDisabled',
      'invalid',
      'frozen',
      'alerted',
      'isEvent',
      'substituted',
      'commandBlocked',
    ])
      if (typeof filter[f] === 'boolean') clauses.push({ [f]: filter[f] })
    if (filter.tagContains) clauses.push({ tag: containsRegex(filter.tagContains) })
    if (filter.descriptionContains)
      clauses.push({ description: containsRegex(filter.descriptionContains) })
  }
  if (clauses.length === 0) return {}
  if (clauses.length === 1) return clauses[0]
  return { $and: clauses }
}

// find-point query by numeric key or tag name (optionally group1-restricted)
function findPointQuery(ctx, tagOrId, applyGroupRestriction) {
  const asNumber = parseInt(tagOrId)
  const key = isNaN(asNumber) ? { tag: tagOrId } : { _id: asNumber }
  if (applyGroupRestriction) {
    const gf = groupAccessFilter(ctx)
    if (gf) return { ...key, ...gf }
  }
  return key
}

function checkTagAccess(ctx, doc) {
  if (!doc) return null
  const g = ctx.rights?.group1List
  if (AUTH && g && g.length > 0) {
    const id = typeof doc._id === 'number' ? doc._id : doc._id?.valueOf?.()
    if (![-1, -2].includes(id) && !g.includes(doc.group1))
      throw gqlError('Access to point denied!', 'FORBIDDEN')
  }
  return doc
}

function getPgPool() {
  if (pgPool) return pgPool
  let pgopt = {}
  if ('PGHOST' in process.env || 'PGHOSTADDR' in process.env) pgopt = null
  else
    pgopt = {
      host: '127.0.0.1',
      database: 'json_scada',
      user: 'json_scada',
      password: 'json_scada',
      port: 5432,
    }
  Log.log('GraphQL: Postgresql - connecting')
  pgPool = new Pool(pgopt)
  pgPool.on('error', (err) => {
    Log.log('GraphQL: Postgresql - ' + err.message)
    try {
      pgPool.end()
    } catch (e) {}
    pgPool = null
  })
  return pgPool
}

function originatorIp(req) {
  return (
    req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress
  )
}

function toObjectId(id, what) {
  try {
    return new ObjectId(id)
  } catch (e) {
    throw gqlError('Invalid ' + (what || 'id') + '!', 'BAD_USER_INPUT')
  }
}

// ----------------------------------------------------------------------------
// Resolvers
// ----------------------------------------------------------------------------

const resolvers = {
  DateTime,
  JSONValue,

  User: {
    roleDetails: async (parent) => {
      return await db.role.find({ _id: { $in: parent.roles } })
    },
  },

  SoeEvent: {
    eventId: (parent) =>
      parent.event_id
        ? parent.event_id.toString()
        : parent._id && typeof parent._id === 'object'
          ? parent._id.toString()
          : null,
    count: (parent) => (typeof parent.count === 'number' ? parent.count : 1),
  },

  Query: {
    serverInfo: async () => {
      return {
        name: 'JSON-SCADA GraphQL API',
        version: '0.3.0',
        timestamp: new Date(),
        authenticationEnabled: AUTH,
        mongoConnected: db.mongoose.connection.readyState === 1,
      }
    },

    me: async (_, __, ctx) => {
      return { username: ctx.username, rights: ctx.rights }
    },

    tags: async (_, { filter, limit, skip, sortBy, sortDesc }, ctx) => {
      const query = buildTagQuery(ctx, filter)
      let sort = { tag: 1 }
      if (typeof sortBy === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(sortBy))
        sort = { [sortBy]: sortDesc ? -1 : 1 }
      return await db.tag
        .find(query)
        .sort(sort)
        .skip(skip > 0 ? Math.floor(skip) : 0)
        .limit(clampLimit(limit))
    },

    tagsCount: async (_, { filter }, ctx) => {
      return await db.tag.countDocuments(buildTagQuery(ctx, filter))
    },

    tag: async (_, { tag }, ctx) => {
      return checkTagAccess(ctx, await db.tag.findOne({ tag: tag }))
    },

    tagById: async (_, { id }, ctx) => {
      return checkTagAccess(ctx, await db.tag.findOne({ _id: id }))
    },

    groups1: async (_, __, ctx) => {
      const match = groupAccessFilter(ctx)
      const pipeline = []
      if (match) pipeline.push({ $match: match })
      pipeline.push({ $group: { _id: '$group1', count: { $sum: 1 } } })
      pipeline.push({ $sort: { _id: 1 } })
      const results = await nativeDb().collection(COLL_REALTIME).aggregate(pipeline).toArray()
      return results.map((r) => ({ name: r._id || '', count: r.count }))
    },

    groups2: async (_, { group1 }, ctx) => {
      const clauses = []
      const af = groupAccessFilter(ctx)
      if (af) clauses.push(af)
      if (typeof group1 === 'string' && group1 !== '') clauses.push({ group1: group1 })
      const pipeline = []
      if (clauses.length > 0) pipeline.push({ $match: { $and: clauses } })
      pipeline.push({ $group: { _id: '$group2', count: { $sum: 1 } } })
      pipeline.push({ $sort: { _id: 1 } })
      const results = await nativeDb().collection(COLL_REALTIME).aggregate(pipeline).toArray()
      return results.map((r) => ({ name: r._id || '', count: r.count }))
    },

    activeAlarms: async (_, { group1, group2, limit }, ctx) => {
      const grp = {}
      if (typeof group1 === 'string' && group1 !== '') grp.group1 = group1
      if (typeof group2 === 'string' && group2 !== '') grp.group2 = group2
      const alarmConditions = {
        $or: [
          {
            $and: [
              { type: 'analog' },
              { alarmDisabled: false },
              { alarmed: true },
              { invalid: false },
            ],
          },
          {
            $and: [
              { type: 'analog' },
              { alarmDisabled: false },
              { alarmRange: { $exists: true, $ne: 0 } },
              { invalid: false },
            ],
          },
          {
            $and: [
              { type: 'digital' },
              { alarmDisabled: false },
              { alarmState: 0 },
              { value: 0 },
              { invalid: false },
            ],
          },
          {
            $and: [
              { type: 'digital' },
              { alarmDisabled: false },
              { alarmState: 1 },
              { value: 1 },
              { invalid: false },
            ],
          },
          { $and: [{ alarmDisabled: false }, { alarmed: true }, { invalid: false }] },
        ],
      }
      const clauses = [alarmConditions]
      const af = tagAccessFilter(ctx)
      if (af) clauses.push(af)
      if (Object.keys(grp).length > 0) clauses.push(grp)
      return await db.tag
        .find({ $and: clauses })
        .sort({ alarmed: -1, timeTagAlarm: -1 })
        .limit(clampLimit(limit))
    },

    soeEvents: async (_, { filter, limit, ascending }, ctx) => {
      filter = filter || {}
      const useSourceTime = filter.useSourceTime === true
      const timeField = useSourceTime ? 'timeTagAtSource' : 'timeTag'

      let timeBegin = filter.timeBegin
      let timeEnd = filter.timeEnd
      if (!timeBegin && !timeEnd) {
        timeBegin = new Date(Date.now() - 60 * 60 * 1000) // default: last hour
      }

      const clauses = []
      if (timeBegin) clauses.push({ [timeField]: { $gte: timeBegin } })
      if (timeEnd) clauses.push({ [timeField]: { $lte: timeEnd } })
      const af = groupAccessFilter(ctx)
      if (af) clauses.push(af)
      if (filter.group1List && filter.group1List.length > 0)
        clauses.push({ group1: { $in: filter.group1List } })
      if (filter.tags && filter.tags.length > 0) clauses.push({ tag: { $in: filter.tags } })
      if (typeof filter.priorityLte === 'number')
        clauses.push({ priority: { $lte: filter.priorityLte } })
      clauses.push({ ack: { $lte: filter.includeRemoved ? 2 : 1 } })

      const match = { $and: clauses }
      const sortDir = ascending ? 1 : -1
      const sort = useSourceTime
        ? { timeTagAtSource: sortDir, timeTag: sortDir, tag: sortDir }
        : { timeTag: sortDir, timeTagAtSource: sortDir, tag: sortDir }

      const soeColl = nativeDb().collection(COLL_SOE)
      if (filter.aggregate === true) {
        return await soeColl
          .aggregate([
            { $match: match },
            {
              $group: {
                _id: '$tag',
                tag: { $last: '$tag' },
                pointKey: { $last: '$pointKey' },
                group1: { $last: '$group1' },
                description: { $last: '$description' },
                eventText: { $last: '$eventText' },
                invalid: { $last: '$invalid' },
                priority: { $last: '$priority' },
                timeTag: { $last: '$timeTag' },
                timeTagAtSource: { $last: '$timeTagAtSource' },
                timeTagAtSourceOk: { $last: '$timeTagAtSourceOk' },
                ack: { $last: '$ack' },
                count: { $sum: 1 },
                event_id: { $last: '$_id' },
              },
            },
          ])
          .sort(sort)
          .limit(clampLimit(limit))
          .toArray()
      }
      return await soeColl.find(match).sort(sort).limit(clampLimit(limit)).toArray()
    },

    historicalData: async (_, { tags, timeBegin, timeEnd, limit }, ctx) => {
      if (!tags || tags.length === 0)
        throw gqlError('At least one tag is required!', 'BAD_USER_INPUT')

      // restrict to tags the user can access (group1 restriction)
      let allowedTags = tags
      const g = ctx.rights?.group1List
      if (AUTH && g && g.length > 0) {
        const accessible = await nativeDb()
          .collection(COLL_REALTIME)
          .find({ tag: { $in: tags }, group1: { $in: g } }, { projection: { tag: 1 } })
          .toArray()
        const accessibleSet = new Set(accessible.map((d) => d.tag))
        allowedTags = tags.filter((t) => accessibleSet.has(t))
      }
      if (allowedTags.length === 0) return []

      const end = timeEnd || new Date()
      const begin = timeBegin || new Date(end.getTime() - 60 * 60 * 1000) // default: last hour

      const pool = getPgPool()
      if (!pool) throw gqlError('Historian database not connected!', 'SERVICE_UNAVAILABLE')
      let resp
      try {
        resp = await pool.query(
          'SELECT tag, value, flags, time_tag, time_tag_at_source FROM hist ' +
            'WHERE time_tag>=$1 AND time_tag<=$2 AND tag = ANY($3) ' +
            'ORDER BY tag ASC, time_tag ASC LIMIT $4',
          [begin, end, allowedTags, clampLimit(limit, MaxHistoryLimit)]
        )
      } catch (err) {
        Log.log('GraphQL: Postgresql error - ' + err.message)
        throw gqlError('Historian database error!', 'SERVICE_UNAVAILABLE')
      }

      const byTag = new Map()
      for (const t of allowedTags) byTag.set(t, [])
      for (const row of resp.rows) {
        if (!byTag.has(row.tag)) byTag.set(row.tag, [])
        const isDigital = typeof row.flags === 'string' && row.flags.charAt(2) === '0'
        byTag.get(row.tag).push({
          value: row.value,
          valueBool: isDigital ? row.value !== 0 : null,
          invalid: typeof row.flags === 'string' ? row.flags.charAt(0) !== '0' : null,
          isDigital: isDigital,
          timeTag: row.time_tag,
          timeTagAtSource: row.time_tag_at_source,
        })
      }
      return Array.from(byTag.entries()).map(([tag, values]) => ({ tag, values }))
    },

    commandStatus: async (_, { commandHandle }, ctx) => {
      const data = await nativeDb()
        .collection(COLL_COMMANDS)
        .findOne({ _id: toObjectId(commandHandle, 'commandHandle') })
      if (!data) return null
      let status = 'PENDING'
      if (typeof data.cancelReason === 'string') status = 'CANCELLED'
      else if (data.ack === true) status = 'ACK_OK'
      else if (data.ack === false) status = 'ACK_FAIL'
      return {
        commandHandle: commandHandle,
        tag: data.tag,
        value: typeof data.value === 'object' ? data.value?.valueOf() : data.value,
        valueString: data.valueString,
        status: status,
        timeTag: data.timeTag,
        ackTimeTag: data.ackTimeTag || null,
        cancelReason: data.cancelReason || null,
        originatorUserName: data.originatorUserName,
      }
    },

    userActions: async (_, { filter, limit, skip }, ctx) => {
      await requireAdmin(ctx)
      filter = filter || {}
      const clauses = []
      if (filter.username) clauses.push({ username: filter.username })
      if (filter.actionContains) clauses.push({ action: containsRegex(filter.actionContains) })
      if (filter.tag) clauses.push({ tag: filter.tag })
      if (filter.timeBegin) clauses.push({ timeTag: { $gte: filter.timeBegin } })
      if (filter.timeEnd) clauses.push({ timeTag: { $lte: filter.timeEnd } })
      const query = clauses.length > 0 ? { $and: clauses } : {}
      return await db.userAction
        .find(query)
        .sort({ timeTag: -1 })
        .skip(skip > 0 ? Math.floor(skip) : 0)
        .limit(clampLimit(limit))
    },

    users: async (_, __, ctx) => {
      await requireAdmin(ctx)
      return await db.user.find()
    },

    roles: async (_, __, ctx) => {
      await requireAdmin(ctx)
      return await db.role.find()
    },

    systemSettings: async (_, __, ctx) => {
      await requireAdmin(ctx)
      return await db.systemSetting.findOne({ key: 'global' })
    },

    protocolDriverInstances: async () => {
      return await db.protocolDriverInstance.find()
    },

    protocolConnections: async () => {
      return await db.protocolConnection.find()
    },

    // ---- legacy query names kept for backward compatibility ----
    getUsers: async (_, __, ctx) => {
      await requireAdmin(ctx)
      return await db.user.find()
    },
    getUserByName: async (_, qry, ctx) => {
      await requireAdmin(ctx)
      return await db.user.findOne({ username: qry.username })
    },
    getTagsByGroup1: async (_, qry, ctx) => {
      return await db.tag
        .find(buildTagQuery(ctx, { group1: qry.group1 }))
        .limit(MaxQueryLimit)
    },
    getTags: async (_, qry, ctx) => {
      return await db.tag.find(buildTagQuery(ctx, { tags: qry.tags })).limit(MaxQueryLimit)
    },
    getTag: async (_, qry, ctx) => {
      return checkTagAccess(ctx, await db.tag.findOne({ tag: qry.tag }))
    },
    getProtocolDriverInstances: async () => {
      return await db.protocolDriverInstance.find()
    },
    getProtocolConnections: async () => {
      return await db.protocolConnection.find()
    },
  },

  Mutation: {
    issueCommand: async (_, { tagOrId, value, valueString }, ctx) => {
      if (typeof value !== 'number' && typeof valueString !== 'string')
        throw gqlError('A value or valueString is required!', 'BAD_USER_INPUT')

      if (AUTH) {
        // check user right for commands in mongodb (not just in the token, for better security)
        if (!(await canSendCommands(ctx.req))) {
          Log.log(`GraphQL: user has no right to issue commands! [${ctx.username}]`)
          throw gqlError('User has no right to issue commands!', 'FORBIDDEN')
        }
      }

      const mdb = nativeDb()
      const cmdVal = typeof value === 'number' ? value : 0.0
      const cmdValStr =
        typeof valueString === 'string' ? valueString : parseFloat(cmdVal).toString()

      // special command tags that start with $$ do not need to be found in the database
      if (typeof tagOrId === 'string' && tagOrId.startsWith('$$')) {
        const result = await mdb.collection(COLL_COMMANDS).insertOne({
          protocolSourceConnectionNumber: new Double(-1),
          protocolSourceCommonAddress: new Double(-1),
          protocolSourceObjectAddress: new Double(-1),
          protocolSourceASDU: new Double(-1),
          protocolSourceCommandDuration: new Double(0),
          protocolSourceCommandUseSBO: false,
          pointKey: 0,
          tag: tagOrId,
          timeTag: new Date(),
          value: new Double(cmdVal),
          valueString: cmdValStr,
          originatorUserName: ctx.username,
          originatorIpAddress: originatorIp(ctx.req),
        })
        if (!result.acknowledged) throw gqlError('Could not queue command!')
        return { ok: true, commandHandle: result.insertedId.toString() }
      }

      // look for the command point in the database
      const data = await mdb
        .collection(COLL_REALTIME)
        .findOne(findPointQuery(ctx, tagOrId, false))
      if (data === null || typeof data._id !== 'number')
        throw gqlError('Command point not found!', 'NOT_FOUND')

      if (AUTH) {
        // check if user can command this group1 destination
        if (!(await canSendCommandTo(ctx.req, data.group1))) {
          Log.log(
            `GraphQL: user has no right to issue commands to the group1 destination! [${ctx.username}] [${data.group1}]`
          )
          throw gqlError(
            'User has no right to issue commands to the group1 destination!',
            'FORBIDDEN'
          )
        }
      }

      let addressing = {}
      if (
        (data.protocolSourceCommonAddress != '' && isNaN(data.protocolSourceCommonAddress)) ||
        isNaN(data.protocolSourceObjectAddress) ||
        isNaN(data.protocolSourceASDU)
      ) {
        // non numerical addressing
        addressing = {
          protocolSourceCommonAddress: data.protocolSourceCommonAddress,
          protocolSourceObjectAddress: data.protocolSourceObjectAddress,
          protocolSourceASDU: data.protocolSourceASDU,
        }
      } else {
        // numerical addressing: force data type as BSON double
        addressing = {
          protocolSourceCommonAddress: new Double(data.protocolSourceCommonAddress),
          protocolSourceObjectAddress: new Double(data.protocolSourceObjectAddress),
          protocolSourceASDU: new Double(data.protocolSourceASDU),
        }
      }

      const result = await mdb.collection(COLL_COMMANDS).insertOne({
        protocolSourceConnectionNumber: new Double(data.protocolSourceConnectionNumber),
        ...addressing,
        protocolSourceCommandDuration: new Double(data.protocolSourceCommandDuration),
        protocolSourceCommandUseSBO: data.protocolSourceCommandUseSBO,
        pointKey: new Double(data._id),
        tag: data.tag,
        timeTag: new Date(),
        value: new Double(cmdVal),
        valueString: cmdValStr,
        originatorUserName: ctx.username,
        originatorIpAddress: originatorIp(ctx.req),
      })
      if (!result.acknowledged) throw gqlError('Could not queue command!')

      // insert command action on SOE list, if desired
      if (DoInsertCommandAsSOE) {
        let eventText = cmdValStr
        if (data.type === 'digital') {
          if (cmdVal) eventText = data.eventTextTrue
          else eventText = data.eventTextFalse
        }
        mdb.collection(COLL_SOE).insertOne({
          tag: data.tag,
          pointKey: data._id,
          description: data.description,
          group1: data.group1,
          eventText: eventText + CommandSentAsSOESymbol,
          invalid: false,
          priority: data.priority,
          timeTag: new Date(),
          timeTagAtSource: new Date(),
          timeTagAtSourceOk: true,
          ack: 1,
        })
      }

      UserActionsQueue.enqueue({
        username: ctx.username,
        pointKey: data._id,
        tag: data.tag,
        action: 'Command',
        properties: { value: new Double(cmdVal), valueString: cmdValStr },
        timeTag: new Date(),
      })

      return { ok: true, commandHandle: result.insertedId.toString() }
    },

    ackEvents: async (_, { action, tag, eventId }, ctx) => {
      requireTokenRight(ctx, 'ackEvents', 'User has no right to ack/remove events!')
      const mdb = nativeDb()
      const gf = groupAccessFilter(ctx) || {}
      let result = null

      switch (action) {
        case 'ACK_ALL_EVENTS': {
          result = await mdb
            .collection(COLL_SOE)
            .updateMany({ ack: 0, ...gf }, { $set: { ack: 1 } })
          UserActionsQueue.enqueue({
            username: ctx.username,
            action: 'Ack All Events',
            timeTag: new Date(),
          })
          break
        }
        case 'REMOVE_ALL_EVENTS': {
          const fromDate = new Date(Date.now() - EventsRemoveGuardSeconds * 1000)
          result = await mdb
            .collection(COLL_SOE)
            .updateMany(
              { ack: { $lte: 1 }, timeTag: { $lte: fromDate }, ...gf },
              { $set: { ack: 2 } }
            )
          UserActionsQueue.enqueue({
            username: ctx.username,
            action: 'Remove All Events',
            timeTag: fromDate,
          })
          break
        }
        case 'ACK_POINT_EVENTS': {
          if (!tag) throw gqlError('A tag is required for this action!', 'BAD_USER_INPUT')
          result = await mdb
            .collection(COLL_SOE)
            .updateMany({ tag: tag, ack: 0, ...gf }, { $set: { ack: 1 } })
          UserActionsQueue.enqueue({
            username: ctx.username,
            action: 'Ack Point Events',
            tag: tag,
            timeTag: new Date(),
          })
          break
        }
        case 'REMOVE_POINT_EVENTS': {
          if (!tag) throw gqlError('A tag is required for this action!', 'BAD_USER_INPUT')
          const fromDate = new Date(Date.now() - EventsRemoveGuardSeconds * 1000)
          result = await mdb
            .collection(COLL_SOE)
            .updateMany(
              { tag: tag, ack: { $lte: 1 }, timeTag: { $lte: fromDate }, ...gf },
              { $set: { ack: 2 } }
            )
          UserActionsQueue.enqueue({
            username: ctx.username,
            action: 'Remove Point Events',
            tag: tag,
            timeTag: fromDate,
          })
          break
        }
        case 'ACK_ONE_EVENT': {
          if (!eventId)
            throw gqlError('An eventId is required for this action!', 'BAD_USER_INPUT')
          const oid = toObjectId(eventId, 'eventId')
          result = await mdb
            .collection(COLL_SOE)
            .updateMany({ _id: oid, ack: 0, ...gf }, { $set: { ack: 1 } })
          UserActionsQueue.enqueue({
            username: ctx.username,
            action: 'Ack One Event',
            tag: tag,
            eventId: oid,
            timeTag: new Date(),
          })
          break
        }
        case 'REMOVE_ONE_EVENT': {
          if (!eventId)
            throw gqlError('An eventId is required for this action!', 'BAD_USER_INPUT')
          const oid = toObjectId(eventId, 'eventId')
          result = await mdb
            .collection(COLL_SOE)
            .updateMany({ _id: oid, ack: { $lte: 1 }, ...gf }, { $set: { ack: 2 } })
          UserActionsQueue.enqueue({
            username: ctx.username,
            action: 'Remove One Event',
            tag: tag,
            eventId: oid,
            timeTag: new Date(),
          })
          break
        }
        default:
          throw gqlError('Unknown action!', 'BAD_USER_INPUT')
      }
      return { ok: true, matchedCount: result ? result.matchedCount : 0 }
    },

    ackAlarms: async (_, { action, tagOrId }, ctx) => {
      requireTokenRight(ctx, 'ackAlarms', 'User has no right to ack or silence alarms!')
      const mdb = nativeDb()
      const gf = groupAccessFilter(ctx) || {}
      let result = null

      switch (action) {
        case 'ACK_ALL_ALARMS': {
          result = await mdb
            .collection(COLL_REALTIME)
            .updateMany({ ...gf }, { $set: { alarmed: false } })
          // make digital event tags return to zero after acknowledged
          await mdb.collection(COLL_REALTIME).updateMany(
            {
              $and: [
                { ...gf },
                { type: 'digital' },
                { isEvent: true },
                { value: 1 },
                { $or: [{ origin: 'supervised' }, { origin: 'calculated' }] },
              ],
            },
            [
              {
                $set: {
                  value: 0,
                  valueString: '$stateTextFalse',
                  timeTagAtSource: null,
                  TimeTagAtSourceOk: null,
                },
              },
            ]
          )
          UserActionsQueue.enqueue({
            username: ctx.username,
            action: 'Ack All Alarms',
            timeTag: new Date(),
          })
          break
        }
        case 'ACK_ONE_ALARM': {
          if (!tagOrId)
            throw gqlError('A tagOrId is required for this action!', 'BAD_USER_INPUT')
          const findPoint = findPointQuery(ctx, tagOrId, true)
          result = await mdb
            .collection(COLL_REALTIME)
            .updateOne(findPoint, { $set: { alarmed: false } })
          // make digital event tag return to zero after acknowledged
          await mdb.collection(COLL_REALTIME).updateOne(
            {
              $and: [
                findPoint,
                { type: 'digital' },
                { isEvent: true },
                { $or: [{ origin: 'supervised' }, { origin: 'calculated' }] },
              ],
            },
            [
              {
                $set: {
                  value: 0,
                  valueString: '$stateTextFalse',
                  timeTagAtSource: null,
                  TimeTagAtSourceOk: null,
                },
              },
            ]
          )
          UserActionsQueue.enqueue({
            username: ctx.username,
            action: 'Ack Point Alarm',
            pointKey: tagOrId,
            timeTag: new Date(),
          })
          break
        }
        case 'SILENCE_BEEP': {
          const g = ctx.rights?.group1List
          if (AUTH && g && g.length > 0) {
            // just remove groups from beep list
            await mdb
              .collection(COLL_REALTIME)
              .updateOne({ _id: beepPointKey }, { $pullAll: { beepGroup1List: g } })
            // force silence when list is empty
            result = await mdb.collection(COLL_REALTIME).updateOne(
              { _id: beepPointKey, beepGroup1List: { $eq: [] } },
              {
                $set: {
                  value: new Double(0),
                  valueString: '0',
                  beepType: new Double(0),
                },
              }
            )
          } else {
            result = await mdb.collection(COLL_REALTIME).updateOne(
              { _id: beepPointKey },
              {
                $set: {
                  value: new Double(0),
                  valueString: '0',
                  beepType: new Double(0),
                  beepGroup1List: [],
                },
              }
            )
          }
          UserActionsQueue.enqueue({
            username: ctx.username,
            action: 'Silence Beep',
            timeTag: new Date(),
          })
          break
        }
        default:
          throw gqlError('Unknown action!', 'BAD_USER_INPUT')
      }
      return { ok: true, matchedCount: result ? result.matchedCount : 0 }
    },

    updateTagProperties: async (_, { tagOrId, properties }, ctx) => {
      const mdb = nativeDb()
      const findPoint = findPointQuery(ctx, tagOrId, false)
      const prevData = await mdb.collection(COLL_REALTIME).findOne(findPoint)
      if (!prevData) throw gqlError('Point not found!', 'NOT_FOUND')

      const set = {}
      if ('alarmDisabled' in properties && properties.alarmDisabled !== null) {
        requireTokenRight(ctx, 'disableAlarms', 'User has no right to disable alarms!')
        if (prevData.alarmDisabled !== properties.alarmDisabled)
          set.alarmDisabled = properties.alarmDisabled
      }
      if ('annotation' in properties && properties.annotation !== null) {
        requireTokenRight(ctx, 'enterAnnotations', 'User has no right to enter annotations!')
        if (prevData.annotation !== properties.annotation)
          set.annotation = properties.annotation
      }
      if ('notes' in properties && properties.notes !== null) {
        requireTokenRight(ctx, 'enterNotes', 'User has no right to enter notes!')
        if (prevData.notes !== properties.notes) set.notes = properties.notes
      }
      for (const lim of ['loLimit', 'hiLimit', 'hysteresis']) {
        if (lim in properties && properties[lim] !== null) {
          requireTokenRight(ctx, 'enterLimits', 'User has no right to enter limits!')
          if (prevData[lim] !== properties[lim]) set[lim] = new Double(properties[lim])
        }
      }
      if (
        'substituted' in properties &&
        properties.substituted !== null &&
        'newValue' in properties &&
        properties.newValue !== null
      ) {
        requireTokenRight(ctx, 'substituteValues', 'User has no right to substitute values!')
        if (prevData.value !== properties.newValue) set.value = new Double(properties.newValue)
      }

      if (Object.keys(set).length === 0) return { ok: true, matchedCount: 0 }

      const result = await mdb.collection(COLL_REALTIME).updateOne(findPoint, { $set: set })
      if (!result.acknowledged) throw gqlError('Could not update point!')

      UserActionsQueue.enqueue({
        username: ctx.username,
        pointKey: prevData._id,
        tag: prevData.tag,
        action: 'Update Properties',
        properties: set,
        timeTag: new Date(),
      })

      // if changed limits/alarm disabling force an update to recheck range
      if (prevData.type === 'analog') {
        if (
          'alarmDisabled' in set ||
          'hiLimit' in set ||
          'loLimit' in set ||
          'hysteresis' in set
        ) {
          mdb.collection(COLL_REALTIME).updateOne(findPoint, {
            $set: {
              sourceDataUpdate: {
                ...prevData.sourceDataUpdate,
                rangeCheck: new Date().getTime(),
              },
            },
          })
        }
      }

      // insert event for changed annotation
      if ('annotation' in set) {
        const eventDate = new Date()
        mdb.collection(COLL_SOE).insertOne({
          tag: prevData.tag,
          pointKey: prevData._id,
          group1: prevData?.group1,
          description: prevData?.description,
          eventText: set.annotation.trim() === '' ? '🏷️🗑️' : '🏷️🔒',
          invalid: false,
          priority: prevData?.priority,
          timeTag: eventDate,
          timeTagAtSource: eventDate,
          timeTagAtSourceOk: true,
          ack: 1,
        })
      }

      // insert event for changed (substituted) value
      if ('value' in set) {
        const eventDate = new Date()
        let eventText = ''
        if (prevData?.type === 'digital')
          eventText =
            set.value == 0 ? prevData?.eventTextFalse : prevData?.eventTextTrue
        else eventText = set.value.valueOf().toFixed(2) + ' ' + prevData?.unit
        mdb.collection(COLL_SOE).insertOne({
          tag: prevData.tag,
          pointKey: prevData._id,
          group1: prevData?.group1,
          description: prevData?.description,
          eventText: eventText,
          invalid: false,
          priority: prevData?.priority,
          timeTag: eventDate,
          timeTagAtSource: eventDate,
          timeTagAtSourceOk: true,
          ack: 1,
        })
      }

      return { ok: true, matchedCount: result.matchedCount }
    },
  },
}

// ----------------------------------------------------------------------------
// Server initialization
// ----------------------------------------------------------------------------

async function initGQLServer(app, dbParam, authentication) {
  db = dbParam
  AUTH = authentication !== false

  const srvApollo = new ApolloServer({
    typeDefs,
    resolvers,
    introspection: true,
  })
  await srvApollo.start()

  const guards = AUTH ? [authJwt.verifyToken] : []
  app.use(
    API_AP,
    cors(),
    express.json({ limit: '50mb' }),
    ...guards,
    expressMiddleware(srvApollo, {
      context: async ({ req }) => buildContext(req),
    })
  )
  Log.log('GraphQL API server mounted on ' + API_AP)
}

module.exports = initGQLServer
