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

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ConnectionManager } from '../jsonscada/connection-manager.js'
import { errorResult, notConnectedResult, textResult } from './util.js'

// A process/driver instance is considered alive when its keep-alive was
// refreshed within this window
const KEEPALIVE_TOLERANCE_MS = 30000

function aliveInfo(doc: any) {
  const keepAlive: Date | null | undefined = doc.activeNodeKeepAliveTimeTag
  const alive =
    keepAlive instanceof Date &&
    Date.now() - keepAlive.getTime() < KEEPALIVE_TOLERANCE_MS
  return {
    activeNodeName: doc.activeNodeName || null,
    activeNodeKeepAliveTimeTag: keepAlive || null,
    alive,
  }
}

export function registerStatusTools(server: McpServer, mgr: ConnectionManager) {
  server.registerTool(
    'get_system_status',
    {
      description:
        'Get a summary of system health: process instances, protocol driver instances ' +
        'and protocol connections, with liveness derived from keep-alive timestamps',
    },
    async () => {
      if (!mgr.status.HintMongoIsConnected) return notConnectedResult()

      try {
        const processes = (
          await mgr.getProcessInstancesCollection().find().toArray()
        ).map((p) => ({
          processName: p.processName,
          processInstanceNumber: p.processInstanceNumber,
          enabled: p.enabled,
          softwareVersion: p.softwareVersion || null,
          ...aliveInfo(p),
        }))

        const drivers = (
          await mgr.getProtocolDriverInstancesCollection().find().toArray()
        ).map((d) => ({
          protocolDriver: d.protocolDriver,
          protocolDriverInstanceNumber: d.protocolDriverInstanceNumber,
          enabled: d.enabled,
          softwareVersion: d.softwareVersion || null,
          ...aliveInfo(d),
        }))

        const connections = (
          await mgr
            .getProtocolConnectionsCollection()
            .find()
            .project({
              protocolDriver: 1,
              protocolDriverInstanceNumber: 1,
              protocolConnectionNumber: 1,
              name: 1,
              description: 1,
              enabled: 1,
              commandsEnabled: 1,
              stats: 1,
            })
            .toArray()
        ).map((c) => {
          const { _id, ...rest } = c
          return rest
        })

        return textResult(
          JSON.stringify(
            {
              processInstances: processes,
              protocolDriverInstances: drivers,
              protocolConnections: connections,
            },
            null,
            2
          )
        )
      } catch (e) {
        return errorResult('Error retrieving system status', e)
      }
    }
  )
}
