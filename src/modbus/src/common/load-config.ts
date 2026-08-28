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

import fs from 'node:fs'
import { ReadPreference, type MongoClientOptions } from 'mongodb'
import Log from './simple-logger.js'

// Shape of the parsed json-scada.json plus the runtime-derived fields the
// drivers rely on. Kept intentionally close to the JS drivers' config object.
export interface JsConfig {
  nodeName: string
  mongoConnectionString: string
  mongoDatabaseName: string

  tlsCaPemFile?: string
  tlsClientPemFile?: string
  tlsClientKeyPassword?: string
  tlsAllowInvalidHostnames?: boolean
  tlsAllowChainErrors?: boolean
  tlsInsecure?: boolean

  // runtime-derived
  Instance: number
  LogLevel: number
  ConnectionNumber: number
  GridFsCollectionName: string
  RealtimeDataCollectionName: string
  SoeDataCollectionName: string
  CommandsQueueCollectionName: string
  ProtocolDriverInstancesCollectionName: string
  ProtocolConnectionsCollectionName: string
  GroupSep: string
  MongoConnectionOptions: MongoClientOptions
}

export interface AppDefs {
  NAME: string
  ENV_PREFIX: string
  VERSION: string
  MSG: string
}

// Load and parse the main configuration file, mirroring the behavior of
// src/mqtt-sparkplug/load-config.js (argument order: instance, logLevel, path).
export function loadConfig(appDefs: AppDefs): JsConfig {
  const args = process.argv.slice(2)

  let confFileArg: string | null = null
  if (args.length > 2) confFileArg = args[2]!

  const configFile =
    confFileArg ||
    process.env[appDefs.ENV_PREFIX + 'CONFIG_FILE'] ||
    process.env['JS_CONFIG_FILE'] ||
    '../../conf/json-scada.json'
  Log.log('Config - Config File: ' + configFile)

  if (!fs.existsSync(configFile)) {
    Log.log('Config - Error: config file not found!')
    process.exit(1)
  }

  const rawFileContents = fs.readFileSync(configFile)
  const configObj = JSON.parse(rawFileContents.toString()) as JsConfig
  if (
    typeof configObj.mongoConnectionString !== 'string' ||
    configObj.mongoConnectionString === ''
  ) {
    Log.log('Error reading config file.')
    process.exit(1)
  }

  Log.levelCurrent = Log.levelNormal
  if (appDefs.ENV_PREFIX + 'LOGLEVEL' in process.env)
    Log.levelCurrent = parseInt(
      process.env[appDefs.ENV_PREFIX + 'LOGLEVEL'] as string
    )
  if (args.length > 1) Log.levelCurrent = parseInt(args[1]!)
  configObj.LogLevel = Log.levelCurrent

  let instArg: number | null = null
  if (args.length > 0) instArg = parseInt(args[0]!)
  configObj.Instance =
    instArg ||
    parseInt(process.env[appDefs.ENV_PREFIX + 'INSTANCE'] || '') ||
    1

  configObj.GridFsCollectionName = 'files'
  configObj.RealtimeDataCollectionName = 'realtimeData'
  configObj.SoeDataCollectionName = 'soeData'
  configObj.CommandsQueueCollectionName = 'commandsQueue'
  configObj.ProtocolDriverInstancesCollectionName = 'protocolDriverInstances'
  configObj.ProtocolConnectionsCollectionName = 'protocolConnections'
  configObj.GroupSep = '~'
  configObj.ConnectionNumber = 0

  Log.log('Config - ' + appDefs.MSG + ' Version ' + appDefs.VERSION)
  Log.log('Config - Instance: ' + configObj.Instance)
  Log.log('Config - Log level: ' + Log.levelCurrent)

  configObj.MongoConnectionOptions = getMongoConnectionOptions(configObj)
  return configObj
}

function getMongoConnectionOptions(configObj: JsConfig): MongoClientOptions {
  const connOptions: MongoClientOptions = {
    readPreference: ReadPreference.PRIMARY,
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
