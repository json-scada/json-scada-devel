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

import * as fs from 'node:fs'
import * as os from 'node:os'
import { ReadPreference, type MongoClientOptions } from 'mongodb'
import Log from './log.js'
import AppDefs from './app-defs.js'
import type { DriverConfig } from './types.js'

// Parses argv/env exactly like the sibling drivers: <instance> <loglevel> <confFile>,
// with JS_NODERED_INSTANCE / JS_NODERED_LOGLEVEL / JS_CONFIG_FILE fallbacks.
export function loadConfig(): DriverConfig {
  const args = process.argv.slice(2)

  const confFileArg = args.length > 2 ? args[2] : null
  const configFile =
    confFileArg || process.env.JS_CONFIG_FILE || '../../conf/json-scada.json'
  Log.log('Config - Config File: ' + configFile)

  if (!fs.existsSync(configFile)) {
    Log.log('Config - Error: config file not found!')
    process.exit(1)
  }

  const raw = fs.readFileSync(configFile)
  const configObj = JSON.parse(raw.toString()) as DriverConfig
  if (
    typeof configObj.mongoConnectionString !== 'string' ||
    configObj.mongoConnectionString === ''
  ) {
    Log.log('Config - Error reading config file.')
    process.exit(1)
  }

  Log.levelCurrent = Log.levelNormal
  if (process.env[AppDefs.ENV_PREFIX + 'LOGLEVEL'] !== undefined)
    Log.levelCurrent = parseInt(
      process.env[AppDefs.ENV_PREFIX + 'LOGLEVEL'] as string
    )
  if (args.length > 1) Log.levelCurrent = parseInt(args[1] as string)
  configObj.LogLevel = Log.levelCurrent

  const instArg = args.length > 0 ? parseInt(args[0] as string) : NaN
  configObj.Instance =
    (Number.isNaN(instArg) ? 0 : instArg) ||
    parseInt(process.env[AppDefs.ENV_PREFIX + 'INSTANCE'] || '') ||
    1

  configObj.nodeName = os.hostname()

  configObj.GridFsCollectionName = 'files'
  configObj.RealtimeDataCollectionName = 'realtimeData'
  configObj.SoeDataCollectionName = 'soeData'
  configObj.CommandsQueueCollectionName = 'commandsQueue'
  configObj.ProtocolDriverInstancesCollectionName = 'protocolDriverInstances'
  configObj.ProtocolConnectionsCollectionName = 'protocolConnections'
  configObj.GroupSep = '~'
  configObj.ConnectionNumber = 0

  Log.log('Config - ' + AppDefs.MSG + ' Version ' + AppDefs.VERSION)
  Log.log('Config - Instance: ' + configObj.Instance)
  Log.log('Config - Node name: ' + configObj.nodeName)
  Log.log('Config - Log level: ' + Log.levelCurrent)

  configObj.MongoConnectionOptions = getMongoConnectionOptions(configObj)
  return configObj
}

function getMongoConnectionOptions(configObj: DriverConfig): MongoClientOptions {
  const connOptions: MongoClientOptions = {
    appName:
      AppDefs.NAME +
      ' Version:' +
      AppDefs.VERSION +
      ' Instance:' +
      configObj.Instance,
    readPreference: ReadPreference.PRIMARY,
    maxPoolSize: 20,
  }

  if (
    typeof configObj.tlsCaPemFile === 'string' &&
    configObj.tlsCaPemFile.trim() !== ''
  ) {
    configObj.tlsClientKeyPassword = configObj.tlsClientKeyPassword || ''
    configObj.tlsAllowInvalidHostnames =
      configObj.tlsAllowInvalidHostnames || false
    configObj.tlsAllowChainErrors = configObj.tlsAllowChainErrors || false
    configObj.tlsInsecure = configObj.tlsInsecure || false

    connOptions.tls = true
    connOptions.tlsCAFile = configObj.tlsCaPemFile
    connOptions.tlsCertificateKeyFile = configObj.tlsClientPemFile
    connOptions.tlsCertificateKeyFilePassword = configObj.tlsClientKeyPassword
    connOptions.tlsAllowInvalidHostnames = configObj.tlsAllowInvalidHostnames
    connOptions.tlsInsecure = configObj.tlsInsecure
  }

  return connOptions
}

export default loadConfig
