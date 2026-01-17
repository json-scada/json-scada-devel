/*
 * Customizable processor of mongodb changes via change streams.
 *
 * THIS FILE IS INTENDED TO BE CUSTOMIZED BY USERS TO DO SPECIAL PROCESSING
 *
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

import { Db, Double, MongoClient } from 'mongodb'
import { setInterval, clearInterval } from 'timers'
import {
  Log,
  ICommandsQueue,
  IRealtimeData,
  IUserAction,
  CollectionNames,
} from './jsonscada/index.js'

let CyclicIntervalHandle: NodeJS.Timeout | null = null

export interface IMongoStatus {
  HintMongoIsConnected: boolean
}

export interface IRedundancy {
  ProcessStateIsActive: () => boolean
}

// this will be called by the main module when mongo is connected (or reconnected)
export const CustomProcessor = function (
  clientMongo: MongoClient | null,
  db: Db,
  Redundancy: IRedundancy,
  MongoStatus: IMongoStatus
) {
  if (clientMongo === null) return

  // -------------------------------------------------------------------------------------------
  // EXAMPLE OF CYCLIC PROCESSING AT INTERVALS
  // BEGIN EXAMPLE

  let CyclicProcess = async function () {
    // do cyclic processing at each CyclicInterval ms

    if (!Redundancy.ProcessStateIsActive() || !MongoStatus.HintMongoIsConnected)
      return // do nothing if process is inactive

    try {
      let res = await db
        .collection(CollectionNames.RealtimeData)
        .findOne({ _id: -2 as any }) // id of point tag with number of digital updates

      if (res) {
        Log.log(
          'Custom Process - Checking number of digital updates: ' +
            (res as unknown as IRealtimeData).valueString
        )
      }
    } catch (err) {
      Log.log(err as string)
    }

    return
  }
  const CyclicInterval = 5000 // interval time in ms
  if (CyclicIntervalHandle) clearInterval(CyclicIntervalHandle) // clear older instances if any
  CyclicIntervalHandle = setInterval(CyclicProcess, CyclicInterval) // start a cyclic processing

  // EXAMPLE OF CYCLIC PROCESSING AT INTERVALS
  // END EXAMPLE
  // -------------------------------------------------------------------------------------------

  
  // -------------------------------------------------------------------------------------------
  // EXAMPLE OF CHANGE STREAM PROCESSING (MONITORING OF CHANGES IN MONGODB COLLECTIONS)
  // BEGIN EXAMPLE

  const changeStreamUserActions = db
    .collection<IUserAction>(CollectionNames.UserActions)
    .watch(
      [{ $match: { operationType: 'insert' } }], // will listen only for insert operations
      {
        fullDocument: 'updateLookup',
      }
    )

  try {
    changeStreamUserActions.on('error', () => {
      if (clientMongo) clientMongo.close()
      // clientMongo = null
      Log.log('Custom Process - Error on changeStreamUserActions!')
    })
    changeStreamUserActions.on('close', () => {
      Log.log('Custom Process - Closed changeStreamUserActions!')
    })
    changeStreamUserActions.on('end', () => {
      if (clientMongo) clientMongo.close()
      // clientMongo = null
      Log.log('Custom Process - Ended changeStreamUserActions!')
    })

    // start listen to changes
    changeStreamUserActions.on('change', (change) => {
      // Log.log(change.fullDocument)

      if (!Redundancy.ProcessStateIsActive()) return // do nothing if process is inactive
      if (change.operationType != 'insert') return // do nothing if operation is not insert

      // when operator acks all alarms
      if (change.fullDocument?.action === 'Ack All Alarms') {
        Log.log('Custom Process - Generating Interrogation Request')

        // insert a command for requesting general interrogation on a IEC 104 connection
        db.collection(CollectionNames.CommandsQueue).insertOne({
          protocolSourceConnectionNumber: new Double(61), // put here number of connection (101/104 client)
          protocolSourceCommonAddress: new Double(1), // put here common address to interrogate
          protocolSourceObjectAddress: new Double(0), // should be 0 for general interrogation
          protocolSourceASDU: new Double(100), // 100 ASDU TYPE for general interrogation C_CS_NA_1
          protocolSourceCommandDuration: new Double(20), // group of interrogation (20-36), 20=general interrogation
          protocolSourceCommandUseSBO: false,
          pointKey: new Double(0),
          tag: '',
          timeTag: new Date(),
          value: new Double(20), // will not be used for interrogation, just for documentation
          valueString: 'general interrogation', // just for documentation
          originatorUserName:
            'custom processor script, action "' +
            change.fullDocument?.action +
            '" of user: ' +
            change.fullDocument?.username, // just for documentation of user action
          originatorIpAddress: '',
          delivered: false,
        } as ICommandsQueue)
      }
    })
  } catch (e) {
    Log.log('Custom Process - Error: ' + e)
  }

  // -------------------------------------------------------------------------------------------
  // EXAMPLE OF CHANGE STREAM PROCESSING (MONITORING OF CHANGES IN MONGODB COLLECTIONS)
  // END EXAMPLE
  
}

export default {
  CustomProcessor,
}
