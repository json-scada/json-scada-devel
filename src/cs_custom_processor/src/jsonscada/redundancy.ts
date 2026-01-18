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
import { Double } from 'mongodb'
import Log from './logger.js'
import { IProcessInstance, ProcessName } from './types.js'
import packageInfo from '../../package.json' with { type: 'json' };
import type { ConnectionManager } from './connection-manager.js'

const VERSION = packageInfo.version || '0.0.0'
const NAME = (packageInfo.name || 'cs_custom_processor').toUpperCase() as ProcessName

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
export function Start(
  interval: number,
  mgr: ConnectionManager
) {
  // check and update redundancy control
  ProcessRedundancy(mgr)
  if (redundancyIntervalHandle) clearInterval(redundancyIntervalHandle)
  redundancyIntervalHandle = setInterval(function () {
    if (!mgr.status.HintMongoIsConnected) {
      Redundancy.ProcessActive = false
      return
    }

    ProcessRedundancy(mgr)
  }, interval)
}

// process JSON-SCADA redundancy state for this driver module
export async function ProcessRedundancy(
  mgr: ConnectionManager
) {
  if (!mgr.client || !mgr.db) {
    Redundancy.ProcessActive = false
    return
  }

  Log.levelCurrent = mgr.jsConfig.LogLevel || 1

  const countKeepAliveUpdatesLimit = 4

  Log.log('Redundancy - Process ' + (Redundancy.ProcessActive ? 'Active' : 'Inactive'))

  try {
    // look for process instance entry, if not found create a new entry
    const collection = mgr.getProcessInstancesCollection()
    const result = await collection.findOne({
      processName: NAME,
      processInstanceNumber: new Double(mgr.jsConfig.Instance!),
    })

    if (!result) {
      // not found, then create
      Redundancy.ProcessActive = true
      Log.log('Redundancy - Instance config not found, creating one...')
      collection.insertOne({
        processName: NAME,
        processInstanceNumber: new Double(mgr.jsConfig.Instance!),
        enabled: true,
        logLevel: new Double(1),
        nodeNames: [],
        activeNodeName: mgr.jsConfig.nodeName,
        activeNodeKeepAliveTimeTag: new Date(),
      } as IProcessInstance)
    } else {
      // check for disabled or node not allowed
      const instance = result as IProcessInstance
      let instKeepAliveTimeTag: string | null = null

      if (
        'activeNodeKeepAliveTimeTag' in instance &&
        instance.activeNodeKeepAliveTimeTag
      )
        instKeepAliveTimeTag = (instance.activeNodeKeepAliveTimeTag as Date).toISOString()

      if (instance?.enabled === false) {
        Log.log('Redundancy - Instance disabled, exiting...')
        process.exit()
      }
      if (
        instance?.nodeNames !== null &&
        Array.isArray(instance.nodeNames) &&
        instance.nodeNames.length > 0
      ) {
        if (!instance.nodeNames.includes(mgr.jsConfig.nodeName as string)) {
          Log.log('Redundancy - Node name not allowed, exiting...')
          process.exit()
        }
      }
      if (instance?.activeNodeName === mgr.jsConfig.nodeName) {
        if (!Redundancy.ProcessActive) Log.log('Redundancy - Node activated!')
        stats.countKeepAliveNotUpdated = 0
        Redundancy.ProcessActive = true
      } else {
        // other node active
        if (Redundancy.ProcessActive) {
          Log.log('Redundancy - Node deactivated!')
          stats.countKeepAliveNotUpdated = 0
        }
        Redundancy.ProcessActive = false
        if (stats.lastActiveNodeKeepAliveTimeTag === instKeepAliveTimeTag) {
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
        if (stats.countKeepAliveNotUpdated > countKeepAliveUpdatesLimit) {
          // cnt exceeded, be active
          stats.countKeepAliveNotUpdated = 0
          Log.log('Redundancy - Node activated!')
          Redundancy.ProcessActive = true
        }
      }

      if (Redundancy.ProcessActive) {
        // process active, then update keep alive
        await collection.updateOne(
          {
            processName: NAME,
            processInstanceNumber: new Double(mgr.jsConfig.Instance!),
          },
          {
            $set: {
              activeNodeName: mgr.jsConfig.nodeName,
              activeNodeKeepAliveTimeTag: new Date(),
              softwareVersion: VERSION,
              stats: {},
            },
          }
        )
      }
    }
  } catch (err) {
    Redundancy.ProcessActive = false
    Log.log('Redundancy - Error: ' + err)
  }
}

export function ProcessStateIsActive() {
  return Redundancy.ProcessActive
}

export const Redundancy = {
  ProcessActive: false,
  ProcessRedundancy,
  Start,
  ProcessStateIsActive,
}

export default Redundancy
