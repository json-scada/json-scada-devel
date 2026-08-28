/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// MODBUS client driver entry point.
// Usage: node dist/client/main.js <instance> <logLevel> <configFile>

import { MongoClient, Double, type Db, type Collection } from 'mongodb'
import Log from '../common/simple-logger.js'
import { loadConfig } from '../common/load-config.js'
import { Redundancy } from '../common/redundancy.js'
import appDefs from './app-defs.js'
import { normalizeConnection } from './conn-config.js'
import { ModbusConnection } from './connection.js'
import { autoCreateTags } from './auto-tag.js'

const config = loadConfig(appDefs)
const redundancy = new Redundancy(appDefs, config)

let mongoClient: MongoClient | null = null
let db: Db | null = null
let mongoConnected = false
const connections = new Map<number, ModbusConnection>()
let wasActive = false
let statsTimer: NodeJS.Timeout | null = null
let bindingsReloadTimer: NodeJS.Timeout | null = null

async function main(): Promise<void> {
  await connectMongo()
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

async function connectMongo(): Promise<void> {
  try {
    Log.log('Mongo - Connecting...')
    mongoClient = new MongoClient(
      config.mongoConnectionString,
      config.MongoConnectionOptions
    )
    await mongoClient.connect()
    db = mongoClient.db(config.mongoDatabaseName)
    mongoConnected = true
    Log.log('Mongo - Connected.')

    mongoClient.on('close', () => {
      mongoConnected = false
      Log.log('Mongo - Connection closed.')
    })

    redundancy.start(5000, db, () => mongoConnected)
    await loadConnections()
    statsTimer = setInterval(() => void tick(), 5000)
  } catch (e) {
    Log.log('Mongo - Connect error: ' + (e as Error).message)
    setTimeout(() => void connectMongo(), 5000)
  }
}

async function loadConnections(): Promise<void> {
  if (!db) return
  const docs = await db
    .collection(config.ProtocolConnectionsCollectionName)
    .find({
      protocolDriver: appDefs.NAME,
      protocolDriverInstanceNumber: config.Instance,
      enabled: true,
    })
    .toArray()

  if (docs.length === 0) {
    Log.log(
      `No enabled connections found for driver ${appDefs.NAME} instance ${config.Instance}. Exiting.`
    )
    await shutdown('NO_CONNECTIONS')
    return
  }

  const rt = db.collection(config.RealtimeDataCollectionName)
  const cmds = db.collection(config.CommandsQueueCollectionName)

  for (const doc of docs) {
    const cfg = normalizeConnection(doc as Record<string, unknown>)
    if (connections.has(cfg.protocolConnectionNumber)) continue
    const conn = new ModbusConnection(cfg, rt, cmds)
    connections.set(cfg.protocolConnectionNumber, conn)
    if (cfg.autoCreateTags) {
      try {
        await autoCreateTags(cfg, rt)
      } catch (e) {
        Log.log(`${cfg.name}: auto-tag error: ${(e as Error).message}`)
      }
    }
    await conn.loadBindings()
    Log.log(
      `Loaded connection ${cfg.protocolConnectionNumber} "${cfg.name}" mode=${cfg.connectionMode}`
    )
  }

  bindingsReloadTimer = setInterval(() => void reloadBindings(), 60000)
}

async function reloadBindings(): Promise<void> {
  if (!redundancy.isActive()) return
  for (const conn of connections.values()) {
    try {
      await conn.loadBindings()
    } catch (e) {
      Log.log(`Bindings reload error: ${(e as Error).message}`)
    }
  }
}

async function tick(): Promise<void> {
  const active = redundancy.isActive()
  if (active && !wasActive) {
    Log.log('Driver - Becoming ACTIVE, starting connections.')
    for (const conn of connections.values()) conn.start()
  } else if (!active && wasActive) {
    Log.log('Driver - Becoming INACTIVE, stopping connections.')
    for (const conn of connections.values()) {
      if (!conn.cfg.keepProtocolRunningWhileInactive) conn.stop()
    }
  }
  wasActive = active
  if (active) await writeStats()
}

async function writeStats(): Promise<void> {
  if (!db) return
  const coll: Collection = db.collection(
    config.ProtocolConnectionsCollectionName
  )
  const ops = []
  for (const conn of connections.values()) {
    ops.push({
      updateOne: {
        filter: {
          protocolDriver: appDefs.NAME,
          protocolDriverInstanceNumber: new Double(config.Instance),
          protocolConnectionNumber: new Double(conn.cfg.protocolConnectionNumber),
        },
        update: {
          $set: {
            stats: {
              ...conn.stats,
              nodeName: config.nodeName,
              timeTag: new Date(),
            },
          },
        },
      },
    })
  }
  if (ops.length) {
    try {
      await coll.bulkWrite(ops, { ordered: false })
    } catch (e) {
      Log.log('Stats write error: ' + (e as Error).message)
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  Log.log(`Driver - ${signal} received, shutting down...`)
  if (statsTimer) clearInterval(statsTimer)
  if (bindingsReloadTimer) clearInterval(bindingsReloadTimer)
  for (const conn of connections.values()) conn.stop()
  try {
    await mongoClient?.close()
  } catch {
    // ignore
  }
  process.exit(0)
}

main().catch((e) => {
  Log.log('Fatal: ' + (e as Error).message)
  process.exit(1)
})
