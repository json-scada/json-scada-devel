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

import { CollectionNames } from './types.js'
import fs from 'fs'
import Log from './simple-logger.js'
import { ReadPreference, MongoClientOptions } from 'mongodb'
import packageInfo from '../../package.json' with { type: 'json' };

const ENV_PREFIX = packageInfo.config.envPrefix || 'JS_CSCUSTOMPROC_'
const MSG = packageInfo.description || '{json:scada} - Change Stream Custom Processor.'
const VERSION = packageInfo.version || '0.0.0'
const NAME = (packageInfo.name || 'cs_custom_processor').toUpperCase()

export interface IConfig {
  mongoConnectionString: string
  mongoDatabaseName: string
  MongoConnectionOptions?: MongoClientOptions
  LogLevel?: number
  Instance?: number
  GridFsCollectionName?: string
  RealtimeDataCollectionName?: string
  UsersCollectionName?: string
  SoeDataCollectionName?: string
  CommandsQueueCollectionName?: string
  ProtocolDriverInstancesCollectionName?: string
  ProtocolConnectionsCollectionName?: string
  ProcessInstancesCollectionName?: string
  GroupSep?: string
  ConnectionNumber?: number
  tlsCaPemFile?: string
  tlsClientPemFile?: string
  tlsClientKeyPassword?: string
  tlsAllowInvalidHostnames?: boolean
  tlsAllowChainErrors?: boolean
  tlsInsecure?: boolean
  nodeName?: string
  [key: string]: any
}

// load and parse config file
function LoadConfig (
  confFileArg?: string,
  logLevelArg?: string,
  instArg?: number
): IConfig {
  let configFile =
    confFileArg || process.env['JS_CONFIG_FILE'] || '../../conf/json-scada.json'
  Log.log('Config - Config File: ' + configFile)

  if (!fs.existsSync(configFile)) {
    Log.log('Config - Error: config file not found!')
    process.exit()
  }

  let rawFileContents = fs.readFileSync(configFile, 'utf8')
  let configObj: IConfig = JSON.parse(rawFileContents)
  if (
    typeof configObj.mongoConnectionString != 'string' ||
    configObj.mongoConnectionString === ''
  ) {
    Log.log('Error reading config file.')
    process.exit()
  }

  Log.levelCurrent = Log.levelNormal
  if (ENV_PREFIX + 'LOGLEVEL' in process.env)
    Log.levelCurrent = parseInt(
      process.env[ENV_PREFIX + 'LOGLEVEL'] || '1'
    )
  if (logLevelArg) Log.levelCurrent = parseInt(logLevelArg)
  configObj.LogLevel = Log.levelCurrent

  configObj.Instance =
    instArg ||
    parseInt(process.env[ENV_PREFIX + 'INSTANCE'] || '1') ||
    1

  configObj.GridFsCollectionName = CollectionNames.GridFs
  configObj.RealtimeDataCollectionName = CollectionNames.RealtimeData
  configObj.UsersCollectionName = CollectionNames.Users
  configObj.SoeDataCollectionName = CollectionNames.SoeData
  configObj.CommandsQueueCollectionName = CollectionNames.CommandsQueue
  configObj.ProtocolDriverInstancesCollectionName = CollectionNames.ProtocolDriverInstances
  configObj.ProtocolConnectionsCollectionName = CollectionNames.ProtocolConnections
  configObj.ProcessInstancesCollectionName = CollectionNames.ProcessInstances
  configObj.GroupSep = '~'
  configObj.ConnectionNumber = 0

  Log.log('Config - ' + MSG + ' Version ' + VERSION)
  Log.log('Config - Instance: ' + configObj.Instance)
  Log.log('Config - Log level: ' + Log.levelCurrent)

  configObj.MongoConnectionOptions = getMongoConnectionOptions(configObj)
  return configObj
}

// prepare mongo connection options
function getMongoConnectionOptions (configObj: IConfig): MongoClientOptions {
  let connOptions: MongoClientOptions = {
    // useNewUrlParser: true,
    // useUnifiedTopology: true,
    appName:
      NAME +
      ' Version:' +
      VERSION +
      ' Instance:' +
      configObj.Instance,
    maxPoolSize: 20,
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

export default LoadConfig
