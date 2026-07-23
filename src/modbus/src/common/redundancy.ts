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

import { Double, type Db } from 'mongodb'
import Log from './simple-logger.js'
import type { AppDefs, JsConfig } from './load-config.js'

// Hot-standby redundancy manager, ported from src/mqtt-sparkplug/redundancy.js.
// Exactly one node runs the protocol at a time; standby nodes watch the active
// node's keep-alive timestamp and take over when it goes stale.
export class Redundancy {
  private processActive = false
  private intervalHandle: NodeJS.Timeout | null = null
  private lastActiveNodeKeepAliveTimeTag: string | null = null
  private countKeepAliveNotUpdated = 0
  private readonly countKeepAliveUpdatesLimit = 4

  constructor(
    private readonly appDefs: AppDefs,
    private readonly configObj: JsConfig
  ) {}

  isActive(): boolean {
    return this.processActive
  }

  start(intervalMs: number, db: Db, mongoIsConnected: () => boolean): void {
    void this.processRedundancy(db)
    if (this.intervalHandle) clearInterval(this.intervalHandle)
    this.intervalHandle = setInterval(() => {
      if (!mongoIsConnected()) {
        this.processActive = false
        return
      }
      void this.processRedundancy(db)
    }, intervalMs)
  }

  private async processRedundancy(db: Db): Promise<void> {
    if (!db) return
    Log.levelCurrent = this.configObj.LogLevel

    Log.log(
      'Redundancy - Process ' + (this.processActive ? 'Active' : 'Inactive')
    )

    try {
      const coll = db.collection(
        this.configObj.ProtocolDriverInstancesCollectionName
      )
      const instance = await coll.findOne({
        protocolDriver: this.appDefs.NAME,
        protocolDriverInstanceNumber: this.configObj.Instance,
      })

      if (!instance) {
        // not found, create one and take over
        this.processActive = true
        Log.log('Redundancy - Instance config not found, creating one...')
        await coll.insertOne({
          protocolDriver: this.appDefs.NAME,
          protocolDriverInstanceNumber: new Double(this.configObj.Instance),
          enabled: true,
          logLevel: new Double(this.configObj.LogLevel),
          nodeNames: [],
          activeNodeName: this.configObj.nodeName,
          activeNodeKeepAliveTimeTag: new Date(),
        })
        return
      }

      let instKeepAliveTimeTag: string | null = null
      if ('activeNodeKeepAliveTimeTag' in instance)
        instKeepAliveTimeTag = (
          instance.activeNodeKeepAliveTimeTag as Date
        ).toISOString()

      if (instance.enabled === false) {
        Log.log('Redundancy - Instance disabled, exiting...')
        process.exit(0)
      }
      if (
        instance.nodeNames !== null &&
        Array.isArray(instance.nodeNames) &&
        instance.nodeNames.length > 0
      ) {
        if (!instance.nodeNames.includes(this.configObj.nodeName)) {
          Log.log('Redundancy - Node name not allowed, exiting...')
          process.exit(0)
        }
      }

      if (instance.activeNodeName === this.configObj.nodeName) {
        if (!this.processActive) Log.log('Redundancy - Node activated!')
        this.countKeepAliveNotUpdated = 0
        this.processActive = true
      } else {
        if (this.processActive) {
          Log.log('Redundancy - Node deactivated!')
          this.countKeepAliveNotUpdated = 0
        }
        this.processActive = false
        if (this.lastActiveNodeKeepAliveTimeTag === instKeepAliveTimeTag) {
          this.countKeepAliveNotUpdated++
          Log.log(
            'Redundancy - Keep-alive from active node not updated. ' +
              this.countKeepAliveNotUpdated
          )
        } else {
          this.countKeepAliveNotUpdated = 0
          Log.log(
            'Redundancy - Keep-alive updated by active node. Staying inactive.'
          )
        }
        this.lastActiveNodeKeepAliveTimeTag = instKeepAliveTimeTag
        if (this.countKeepAliveNotUpdated > this.countKeepAliveUpdatesLimit) {
          this.countKeepAliveNotUpdated = 0
          Log.log('Redundancy - Node activated!')
          this.processActive = true
        }
      }

      if (this.processActive) {
        await coll.updateOne(
          {
            protocolDriver: this.appDefs.NAME,
            protocolDriverInstanceNumber: new Double(this.configObj.Instance),
          },
          {
            $set: {
              activeNodeName: this.configObj.nodeName,
              activeNodeKeepAliveTimeTag: new Date(),
              softwareVersion: this.appDefs.VERSION,
              stats: {},
            },
          }
        )
      }
    } catch (err) {
      Log.log('Redundancy - Error: ' + err)
    }
  }
}
