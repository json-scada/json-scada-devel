/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// MODBUS_SERVER driver entry point.
// Usage: node dist/server/main.js <instance> <logLevel> <configFile>

import { MongoClient, Double, type Db, type Collection } from 'mongodb'
import Log from '../common/simple-logger.js'
import { loadConfig } from '../common/load-config.js'
import { Redundancy } from '../common/redundancy.js'
import appDefs from './app-defs.js'
import { normalizeServerConnection } from './conn-config.js'
import { ModbusServer } from './connection.js'

const config = loadConfig(appDefs)
const redundancy = new Redundancy(appDefs, config)

let mongoClient: MongoClient | null = null
let db: Db | null = null
let mongoConnected = false
const servers = new Map<number, ModbusServer>()
let wasActive = false
let statsTimer: NodeJS.Timeout | null = null

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
    await loadServers()
    statsTimer = setInterval(() => void tick(), 5000)
  } catch (e) {
    Log.log('Mongo - Connect error: ' + (e as Error).message)
    setTimeout(() => void connectMongo(), 5000)
  }
}

async function loadServers(): Promise<void> {
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
    const cfg = normalizeServerConnection(doc as Record<string, unknown>)
    if (servers.has(cfg.protocolConnectionNumber)) continue
    servers.set(
      cfg.protocolConnectionNumber,
      new ModbusServer(cfg, rt, cmds)
    )
    Log.log(
      `Loaded server ${cfg.protocolConnectionNumber} "${cfg.name}" mode=${cfg.connectionMode}`
    )
  }
}

async function tick(): Promise<void> {
  const active = redundancy.isActive()
  if (active && !wasActive) {
    Log.log('Driver - Becoming ACTIVE, starting servers.')
    for (const s of servers.values()) {
      try {
        await s.start()
      } catch (e) {
        Log.log(`Server start error: ${(e as Error).message}`)
      }
    }
  } else if (!active && wasActive) {
    Log.log('Driver - Becoming INACTIVE, stopping servers.')
    for (const s of servers.values()) {
      if (!s.cfg.keepProtocolRunningWhileInactive) s.stop()
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
  for (const s of servers.values()) {
    ops.push({
      updateOne: {
        filter: {
          protocolDriver: appDefs.NAME,
          protocolDriverInstanceNumber: new Double(config.Instance),
          protocolConnectionNumber: new Double(s.cfg.protocolConnectionNumber),
        },
        update: {
          $set: {
            stats: { ...s.stats, nodeName: config.nodeName, timeTag: new Date() },
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
  for (const s of servers.values()) s.stop()
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
