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

import { MongoClient, Db } from 'mongodb'
import Log from './simple-logger.js'
import LoadConfig, { IConfig } from './load-config.js'

export class MongoConnectionManager {
  public status = { HintMongoIsConnected: false }
  public jsConfig!: IConfig
  private client: MongoClient | null = null

  constructor() {
    const args = process.argv.slice(2)
    let inst: number | undefined = undefined
    if (args.length > 0) inst = parseInt(args[0]!)

    let logLevel: string | undefined = undefined
    if (args.length > 1) logLevel = args[1]
    let confFile: string | undefined = undefined
    if (args.length > 2) confFile = args[2]

    this.jsConfig = LoadConfig(confFile, logLevel, inst)
  }

  public async run(onConnect: (client: MongoClient, db: Db) => void) {
    Log.log('Connecting to MongoDB server...')
    while (true) {
      if (this.client === null) {
        try {
          this.client = await MongoClient.connect(
            this.jsConfig.mongoConnectionString,
            this.jsConfig.MongoConnectionOptions
          )
          this.status.HintMongoIsConnected = true
          const db = this.client.db(this.jsConfig.mongoDatabaseName)
          Log.log('Connected correctly to MongoDB server')
          onConnect(this.client, db)
        } catch (err) {
          if (this.client) (this.client as MongoClient).close()
          this.client = null
          Log.log(err as string)
        }
      }

      // wait 5 seconds
      await new Promise((resolve) => setTimeout(resolve, 5000))

      // detect connection problems, if error will null the client to later reconnect
      if (this.client === null) {
        Log.log('Disconnected Mongodb!')
      } else {
        if (!(await this.checkConnectedMongo(this.client))) {
          // not anymore connected, will retry
          Log.log('Disconnected Mongodb!')
          if (this.client) (this.client as MongoClient).close()
          this.client = null
        }
      }
    }
  }

  private async checkConnectedMongo(client: MongoClient): Promise<boolean> {
    if (!client) return false
    try {
      const res = await client.db('admin').command({ ping: 1 })
      const isOk = res && 'ok' in res && res['ok']
      this.status.HintMongoIsConnected = !!isOk
      return !!isOk
    } catch (e) {
      Log.log('Error on mongodb connection!')
      this.status.HintMongoIsConnected = false
      return false
    }
  }
}
