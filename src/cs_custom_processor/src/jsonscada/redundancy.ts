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

import { setInterval, clearInterval } from 'timers'
import { Double, MongoClient, Db } from 'mongodb'
import Log from './logger.js'
import { IConfig } from './load-config.js'
import { IProtocolDriverInstance } from './types.js'
import packageInfo from '../../package.json' with { type: 'json' };

const VERSION = packageInfo.version || '0.0.0'
const NAME = (packageInfo.name || 'cs_custom_processor').toUpperCase()

let ProcessActive = false // redundancy state
let redundancyIntervalHandle: NodeJS.Timeout | null = null // timer handle

interface RedundancyStats {
  lastActiveNodeKeepAliveTimeTag?: string | null;
  countKeepAliveNotUpdated: number;
}

const stats: RedundancyStats = {
  lastActiveNodeKeepAliveTimeTag: null,
  countKeepAliveNotUpdated: 0
};

// start processing redundancy
export function Start(interval: number, clientMongo: MongoClient, db: Db, configObj: IConfig, MongoStatus: { HintMongoIsConnected: boolean }) {
  // check and update redundancy control
  ProcessRedundancy(clientMongo, db, configObj)
  if (redundancyIntervalHandle) clearInterval(redundancyIntervalHandle)
  redundancyIntervalHandle = setInterval(function () {
    if (!MongoStatus.HintMongoIsConnected) {
      ProcessActive = false
      return
    }

    ProcessRedundancy(clientMongo, db, configObj)
  }, interval)
}

// process JSON-SCADA redundancy state for this driver module
export async function ProcessRedundancy(clientMongo: MongoClient | null, db: Db | null, configObj: IConfig) {
  if (!clientMongo || !db) {
    ProcessActive = false
    return
  }

  Log.levelCurrent = configObj.LogLevel || 1

  const countKeepAliveUpdatesLimit = 4

  Log.log('Redundancy - Process ' + (ProcessActive ? 'Active' : 'Inactive'))

  try {
    // look for process instance entry, if not found create a new entry
    const result = await db
      .collection(configObj.ProcessInstancesCollectionName!)
      .findOne({
        processName: NAME,
        processInstanceNumber: new Double(configObj.Instance!),
      })

    if (!result) {
      // not found, then create
      ProcessActive = true
      Log.log('Redundancy - Instance config not found, creating one...')
      db.collection(configObj.ProcessInstancesCollectionName!).insertOne({
        processName: NAME,
        processInstanceNumber: new Double(configObj.Instance!),
        enabled: true,
        logLevel: new Double(1),
        nodeNames: [],
        activeNodeName: configObj.nodeName,
        activeNodeKeepAliveTimeTag: new Date(),
      })
    } else {
      // check for disabled or node not allowed
      const instance = result as IProtocolDriverInstance
      let instKeepAliveTimeTag: string | null = null

      if ('activeNodeKeepAliveTimeTag' in instance && instance.activeNodeKeepAliveTimeTag)
        instKeepAliveTimeTag = (instance.activeNodeKeepAliveTimeTag as Date).toISOString()

      if (instance?.enabled === false) {
        Log.log('Redundancy - Instance disabled, exiting...')
        process.exit()
      }
      if (instance?.nodeNames !== null && Array.isArray(instance.nodeNames) && instance.nodeNames.length > 0) {
        if (!instance.nodeNames.includes(configObj.nodeName as string)) {
          Log.log('Redundancy - Node name not allowed, exiting...')
          process.exit()
        }
      }
      if (instance?.activeNodeName === configObj.nodeName) {
        if (!ProcessActive) Log.log('Redundancy - Node activated!')
        stats.countKeepAliveNotUpdated = 0
        ProcessActive = true
      } else {
        // other node active
        if (ProcessActive) {
          Log.log('Redundancy - Node deactivated!')
          stats.countKeepAliveNotUpdated = 0
        }
        ProcessActive = false
        if (
          stats.lastActiveNodeKeepAliveTimeTag ===
          instKeepAliveTimeTag
        ) {
          stats.countKeepAliveNotUpdated++
          Log.log(
            'Redundancy - Keep-alive from active node not updated. ' +
              stats.countKeepAliveNotUpdated
          )
        } else {
          stats.countKeepAliveNotUpdated = 0
          Log.log(
            'Redundancy - Keep-alive updated by active node. Staying inactive.'
          )
        }
        stats.lastActiveNodeKeepAliveTimeTag = instKeepAliveTimeTag
        if (
          stats.countKeepAliveNotUpdated >
          countKeepAliveUpdatesLimit
        ) {
          // cnt exceeded, be active
          stats.countKeepAliveNotUpdated = 0
          Log.log('Redundancy - Node activated!')
          ProcessActive = true
        }
      }

      if (ProcessActive) {
        // process active, then update keep alive
        db.collection(configObj.ProcessInstancesCollectionName!).updateOne(
          {
            processName: NAME,
            processInstanceNumber: new Double(configObj.Instance!),
          },
          {
            $set: {
              activeNodeName: configObj.nodeName,
              activeNodeKeepAliveTimeTag: new Date(),
              softwareVersion: VERSION,
              stats: {},
            },
          }
        )
      }
    }
  } catch (err) {
    ProcessActive = false
    Log.log('Redundancy - Error: ' + err)
  }
}

export function ProcessStateIsActive() {
  return ProcessActive
}

export default {
  ProcessRedundancy,
  Start,
  ProcessStateIsActive,
}
