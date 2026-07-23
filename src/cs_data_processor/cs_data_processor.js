/*
 * A process that watches for raw data updates from protocols using a MongoDB change stream.
 * Converts raw protocol values into analogs/statuses then updates realtime, soe and historical data.
 * {json:scada} - Copyright (c) 2020-2025 - Ricardo L. Olsen
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

'use strict'

const AppDefs = require('./app-defs')
const Log = require('./simple-logger')
const LoadConfig = require('./load-config')
const Redundancy = require('./redundancy')
const sqlFilesPath = '../../sql/'
const fs = require('fs')
const { MongoClient, Double } = require('mongodb')
const Queue = require('queue-fifo')
const { setInterval } = require('timers')

const MongoStatus = { HintMongoIsConnected: false }
const LowestPriorityThatBeeps = 1 // will beep for priorities zero and one

process.on('uncaughtException', (err) =>
  Log.log('Uncaught Exception: ' + (err?.stack || err?.message || JSON.stringify(err)))
)

const args = process.argv.slice(2)
var inst = null
if (args.length > 0) inst = parseInt(args[0])

var logLevel = null
if (args.length > 1) logLevel = parseInt(args[1])
var confFile = null
if (args.length > 2) confFile = args[2]

const jsConfig = LoadConfig(confFile, logLevel, inst)

let DivideProcessingExpression = {}
if (
  AppDefs.ENV_PREFIX + 'DIVIDE_EXP' in process.env &&
  process.env[AppDefs.ENV_PREFIX + 'DIVIDE_EXP'].trim() !== ''
) {
  try {
    DivideProcessingExpression = JSON.parse(
      process.env[AppDefs.ENV_PREFIX + 'DIVIDE_EXP']
    )
    Log.log(
      'Divide Processing Expression: ' +
        JSON.stringify(DivideProcessingExpression)
    )
  } catch (e) {
    DivideProcessingExpression = {}
    Log.log('Divide Processing Expression: ERROR!' + e)
    process.exit(1)
  }
}

const beepPointKey = -1
const cntUpdatesPointKey = -2
const invalidDetectCycle = 43000

Log.log('Connecting to MongoDB server...')

const pipeline = [
  {
    $project: { documentKey: false },
  },
  {
    $match: {
      $and: [
        { 'fullDocument.value': { $exists: true } },
        DivideProcessingExpression,
        {
          'updateDescription.updatedFields.sourceDataUpdate': { $exists: true },
        },
        {
          $or: [{ operationType: 'update' }, { operationType: 'insert' }],
        },
      ],
    },
  },
]

;(async () => {
  let collection = null
  let histCollection = null
  let sqlHistQueue = new Queue() // queue of historical values to insert on postgreSQL
  let sqlRtDataQueue = new Queue() // queue of realtime values to insert on postgreSQL
  let mongoRtDataQueue = new Queue() // queue of realtime values to insert on MongoDB
  let digitalUpdatesCount = 0
  let clientMongo = null

  // mark as frozen unchanged analog values greater than 1 after timeout
  setInterval(async function () {
    if (collection && MongoStatus.HintMongoIsConnected && clientMongo) {
      collection
        .updateMany(
          {
            $and: [
              { type: 'analog' },
              { invalid: false },
              { frozen: false },
              { frozenDetectTimeout: { $gt: 0.0 } },
              { timeTag: { $ne: null } },
              { $expr: { $gt: [{ $abs: '$value' }, 1.0] } },
              {
                $expr: {
                  $lt: [
                    '$timeTag',
                    {
                      $subtract: [
                        new Date(),
                        { $multiply: ['$frozenDetectTimeout', 1000.0] },
                      ],
                    },
                  ],
                },
              },
            ],
          },
          { $set: { frozen: true } }
        )
        .catch(function (err) {
          Log.log('Error on Mongodb query!', err)
        })
    }
  }, 17317)

  // process updates to mongo/realtimeData
  async function processRtDataMongoUpdates() {
    if (
      !collection ||
      !clientMongo ||
      !MongoStatus.HintMongoIsConnected ||
      mongoRtDataQueue.isEmpty()
    ) {
      setTimeout(processRtDataMongoUpdates, 150)
      return
    }
    let cnt = 0
    let updArr = []
    while (!mongoRtDataQueue.isEmpty()) {
      const upd = mongoRtDataQueue.peek()
      mongoRtDataQueue.dequeue()
      const _id = upd._id
      delete upd._id // remove _id for update
      let addToSet = null
      if ('$addToSet' in upd) {
        addToSet = upd.$addToSet
        delete upd.$addToSet
      }
      updArr.push({
        updateOne: {
          filter: { _id: _id },
          update: { $set: upd },
        },
      })
      cnt++
      if (addToSet) {
        updArr.push({
          updateOne: {
            filter: { _id: _id },
            update: { $addToSet: addToSet },
          },
        })
        cnt++
      }
    }
    const res = await collection
      .bulkWrite(updArr, {
        ordered: false,
        writeConcern: {
          w: 0,
        },
      })
      .catch(function (err) {
        Log.log('Error on Mongodb query!', err)
      })
    if (cnt) Log.log('Mongo Updates ' + cnt)
    setTimeout(processRtDataMongoUpdates, 150)
  }
  processRtDataMongoUpdates()

  // write values to sql files for later insertion on postgreSQL, and mongo hist
  async function processSqlAndMongoHistUpdates() {
    if (!histCollection || !clientMongo || !MongoStatus.HintMongoIsConnected) {
      setTimeout(processSqlAndMongoHistUpdates, 333)
      return
    }

    try {
      let doInsertData = false
      let sqlTransaction =
        'START TRANSACTION;\n' +
        'INSERT INTO hist (tag, time_tag, value, value_json, time_tag_at_source, flags) VALUES '

      let cntH = 0
      let insertArr = []
      while (!sqlHistQueue.isEmpty()) {
        doInsertData = true
        let entry = sqlHistQueue.peek()
        sqlHistQueue.dequeue()
        sqlTransaction = sqlTransaction + '\n(' + entry.sql + '),'
        insertArr.push(entry.obj)
        cntH++
      }
      if (cntH) Log.log('PGSQL/Mongo Hist updates ' + cntH)

      if (doInsertData) {
        histCollection
          .insertMany(insertArr, { ordered: false, writeConcern: { w: 0 } })
          .catch(function (err) {
            Log.log('Error on Mongodb query!', err)
          })
        sqlTransaction = sqlTransaction.substring(0, sqlTransaction.length - 1) // remove last comma
        sqlTransaction = sqlTransaction + ' \n'
        // this cause problems when tag/time repeated on same transaction
        // sqlTransaction = sqlTransaction + "ON CONFLICT (tag, time_tag) DO UPDATE SET value=EXCLUDED.value, value_json=EXCLUDED.value_json, time_tag_at_source=EXCLUDED.time_tag_at_source, flags=EXCLUDED.flags;\n";
        sqlTransaction =
          sqlTransaction + 'ON CONFLICT (tag, time_tag) DO NOTHING;\n'
        sqlTransaction = sqlTransaction + 'COMMIT;\n'
        fs.writeFile(
          sqlFilesPath +
            'pg_hist_' +
            new Date().getTime() +
            '_' +
            jsConfig.Instance +
            '.sql',
          sqlTransaction,
          (err) => {
            if (err) Log.log('Error writing SQL file!')
          }
        )
      }

      doInsertData = false
      sqlTransaction = ''
      let cntR = 0
      sqlTransaction =
        sqlTransaction +
        'WITH ordered_values AS (  SELECT DISTINCT ON (tag) tag, time_tag, json_data FROM (VALUES '
      while (!sqlRtDataQueue.isEmpty()) {
        doInsertData = true
        let sql = sqlRtDataQueue.peek()
        sqlRtDataQueue.dequeue()
        sqlTransaction = sqlTransaction + '\n (' + sql + '),'
        cntR++
      }
      sqlTransaction = sqlTransaction.substring(0, sqlTransaction.length - 1) // remove last comma
      sqlTransaction = sqlTransaction + ' \n'
      sqlTransaction =
        sqlTransaction +
        `) AS t(tag, time_tag, json_data)
          ORDER BY tag, time_tag DESC
        )
        INSERT INTO realtime_data (tag, time_tag, json_data)
        SELECT tag, time_tag::timestamptz, json_data::jsonb
        FROM ordered_values
        ON CONFLICT (tag) DO UPDATE 
        SET time_tag = EXCLUDED.time_tag,
            json_data = EXCLUDED.json_data;
    `
      if (cntR) Log.log('PGSQL RT updates ' + cntR)

      if (doInsertData) {
        fs.writeFile(
          sqlFilesPath +
            'pg_rtdata_' +
            new Date().getTime() +
            '_' +
            jsConfig.Instance +
            '.sql',
          sqlTransaction,
          (err) => {
            if (err) Log.log('Error writing SQL file!')
          }
        )
      }
    } catch (e) {
      Log.log('Error in processSqlAndMongoHistUpdates: ' + e)
    }
    setTimeout(processSqlAndMongoHistUpdates, 333)
  }
  processSqlAndMongoHistUpdates()

  let invalidDetectIntervalHandle = null
  let latencyIntervalHandle = null
  let resumeToken = null
  let prevResumeToken = null
  while (true) {
    if (clientMongo === null)
      await MongoClient.connect(
        jsConfig.mongoConnectionString,
        jsConfig.MongoConnectionOptions
      )
        .then(async (client) => {
          clientMongo = client
          clientMongo.on('topologyClosed', () => {
            MongoStatus.HintMongoIsConnected = false
            clientMongo = null
            Log.log('MongoDB server topologyClosed')
          })
          MongoStatus.HintMongoIsConnected = true
          Log.log('Connected correctly to MongoDB server')
          if (resumeToken)
            Log.log('resumeToken: ' + JSON.stringify(resumeToken))

          let latencyAccTotal = 0
          let latencyTotalCnt = 0
          let latencyAccMinute = 0
          let latencyMinuteCnt = 0
          let latencyPeak = 0
          clearInterval(latencyIntervalHandle)
          latencyIntervalHandle = setInterval(function () {
            latencyAccMinute = 0
            latencyMinuteCnt = 0
          }, 60000)

          // specify db and collections
          const db = client.db(jsConfig.mongoDatabaseName)
          collection = db.collection(jsConfig.RealtimeDataCollectionName)
          histCollection = db.collection(jsConfig.HistCollectionName)
          const changeStream = collection.watch(pipeline, {
            fullDocument: 'updateLookup',
            resumeAfter: resumeToken,
          })

          await createSpecialTags(collection)

          Redundancy.Start(5000, clientMongo, db, jsConfig, MongoStatus)

          // periodically, mark invalid data when supervised points not updated within specified period (invalidDetectTimeout) for the point
          // check also stopped protocol driver instances
          clearInterval(invalidDetectIntervalHandle)
          invalidDetectIntervalHandle = setInterval(async function () {
            if (clientMongo !== null && MongoStatus.HintMongoIsConnected) {
              collection
                .updateMany(
                  {
                    $expr: {
                      $and: [
                        { $eq: ['$origin', 'supervised'] },
                        { $ne: ['$substituted', true] },
                        { $eq: ['$invalid', false] },
                        {
                          $lt: [
                            '$sourceDataUpdate.timeTag',
                            {
                              $subtract: [
                                new Date(),
                                { $multiply: [1000, '$invalidDetectTimeout'] },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  },
                  { $set: { invalid: true } }
                )
                .catch(function (err) {
                  Log.log('Error on Mongodb query!', err)
                })

              // look for client drivers instance not updating keep alive, if found invalidate all related data points of all its connections
              const results = await db
                .collection(jsConfig.ProtocolDriverInstancesCollectionName)
                .find({
                  $expr: {
                    $and: [
                      {
                        $in: [
                          '$protocolDriver',
                          [
                            'IEC60870-5-104',
                            'IEC60870-5-101',
                            'IEC60870-5-103',
                            'DNP3',
                            'MQTT-SPARKPLUG-B',
                            'OPC-UA',
                            'OPC-DA',
                            'TELEGRAF-LISTENER',
                            'PLCTAG',
                            'PLC4X',
                            'MODBUS',
                            'IEC61850',
                            'ICCP',
                          ],
                        ],
                      },
                      { $eq: ['$enabled', true] },
                      {
                        $lt: [
                          '$activeNodeKeepAliveTimeTag',
                          {
                            $subtract: [new Date(), { $multiply: [1000, 15] }],
                          },
                        ],
                      },
                    ],
                  },
                })
                .toArray()

              if (results && results.length > 0)
                for (let i = 0; i < results.length; i++) {
                  Log.log('PROTOCOL INSTANCE NOT RUNNING DETECTED!')
                  let instance = results[i]
                  Log.log(
                    'Driver Name: ' +
                      instance?.protocolDriver +
                      ' Instance Number: ' +
                      instance?.protocolDriverInstanceNumber
                  )
                  // find all connections related to his instance
                  const res = await db
                    .collection(jsConfig.ProtocolConnectionsCollectionName)
                    .find({
                      protocolDriver: instance?.protocolDriver,
                      protocolDriverInstanceNumber:
                        instance?.protocolDriverInstanceNumber,
                    })
                    .toArray()

                  if (res && res.length > 0)
                    for (let i = 0; i < res.length; i++) {
                      let connection = res[i]
                      Log.log(
                        'Data invalidated for connection: ' +
                          connection?.protocolConnectionNumber
                      )
                      await db
                        .collection(jsConfig.RealtimeDataCollectionName)
                        .updateMany(
                          {
                            origin: 'supervised',
                            protocolSourceConnectionNumber:
                              connection?.protocolConnectionNumber,
                            invalid: false,
                          },
                          {
                            $set: {
                              invalid: true,
                            },
                          }
                        )
                        .catch(function (err) {
                          Log.log('Error on Mongodb query!', err)
                        })
                    }
                }
            }
          }, invalidDetectCycle)

          try {
            changeStream.on('error', (change) => {
              if (resumeToken !== null && resumeToken === prevResumeToken) {
                // if resumeToken is the same, it means the error is not recoverable, so cancel the resumeToken
                prevResumeToken = null
                resumeToken = null
              }
              prevResumeToken = resumeToken
              if (clientMongo) clientMongo.close()
              clientMongo = null
              Log.log('Error on ChangeStream!')
            })
            changeStream.on('close', (change) => {
              if (resumeToken !== null && resumeToken === prevResumeToken) {
                // if resumeToken is the same, it means the error is not recoverable, so cancel the resumeToken
                prevResumeToken = null
                resumeToken = null
              }
              prevResumeToken = resumeToken
              clientMongo = null
              Log.log('Closed ChangeStream!')
            })
            changeStream.on('end', (change) => {
              if (clientMongo) clientMongo.close()
              clientMongo = null
              Log.log('Ended ChangeStream!')
            })

            // start listen to changes
            changeStream.on('change', (change) => {
              try {
                resumeToken = changeStream.resumeToken
                if (change.operationType === 'delete') return

                const fullDocument = change.fullDocument

                // // for older versions of mongodb
                // if (
                //   change.operationType === 'replace' &&
                //   !change?.updateDescription?.updatedFields &&
                //   fullDocument.sourceDataUpdate
                // ) {
                //   change['updateDescription'] = {
                //     updatedFields: {
                //       sourceDataUpdate: fullDocument.sourceDataUpdate,
                //     },
                //   }
                // }

                let isSOE = false
                let alarmRange = 0

                if (change.operationType === 'insert') {
                  // document inserted
                  Log.log(
                    'INSERT ' +
                      fullDocument._id +
                      ' ' +
                      fullDocument.tag +
                      ' ' +
                      fullDocument.value
                  )

                  sqlRtDataQueue.enqueue(
                    "'" +
                      fullDocument.tag.replaceAll("'", "''") +
                      "'," +
                      "'" +
                      new Date().toISOString() +
                      "'," +
                      "to_json('" +
                      JSON.stringify(fullDocument).replaceAll(
                        "'",
                        "''"
                      ) +
                      "'::text)"
                  )
                  return
                }

                if (!Redundancy.ProcessStateIsActive())
                  // when inactive, ignore changes
                  return

                if (
                  !(
                    'sourceDataUpdate' in change.updateDescription.updatedFields
                  )
                )
                  // if not a Source Data Update (protocol update), return
                  return

                const sourceDataUpdate =
                  change.updateDescription.updatedFields.sourceDataUpdate

                let delay =
                  new Date().getTime() - sourceDataUpdate.timeTag.getTime()
                latencyAccTotal += delay
                latencyTotalCnt++
                latencyAccMinute += delay
                latencyMinuteCnt++
                if (delay > latencyPeak) latencyPeak = delay

                // consider SOE when digital changes has field timestamp
                // or analog with isEvent true
                if ('timeTagAtSource' in sourceDataUpdate)
                  if (sourceDataUpdate.timeTagAtSource !== null)
                    if (
                      fullDocument.type === 'digital' ||
                      (fullDocument.type === 'analog' &&
                        fullDocument.isEvent)
                    ) {
                      if (
                        sourceDataUpdate.timeTagAtSource.getFullYear() > 1899
                      ) {
                        isSOE = true
                      }
                    }

                // check quality bits set by the protocol driver
                let invalid = false,
                  transient = false,
                  overflow = false,
                  nottopical = false,
                  carry = false,
                  substituted = false,
                  blocked = false
                if (typeof sourceDataUpdate.invalidAtSource === 'boolean') {
                  invalid = sourceDataUpdate.invalidAtSource
                }
                if (typeof sourceDataUpdate.notTopicalAtSource === 'boolean') {
                  invalid = invalid || sourceDataUpdate.notTopicalAtSource
                  nottopical = sourceDataUpdate.notTopicalAtSource
                }
                if (typeof sourceDataUpdate.overflowAtSource === 'boolean') {
                  invalid = invalid || sourceDataUpdate.overflowAtSource
                  overflow = sourceDataUpdate.overflowAtSource
                }
                if (typeof sourceDataUpdate.transientAtSource === 'boolean') {
                  invalid = invalid || sourceDataUpdate.transientAtSource
                  transient = sourceDataUpdate.transientAtSource
                }
                if (typeof sourceDataUpdate.carryAtSource === 'boolean') {
                  carry = sourceDataUpdate.carryAtSource
                }
                if (typeof sourceDataUpdate.substitutedAtSource === 'boolean') {
                  substituted = sourceDataUpdate.substitutedAtSource
                }
                if (typeof sourceDataUpdate.blockedAtSource === 'boolean') {
                  blocked = sourceDataUpdate.blockedAtSource
                }

                let value = sourceDataUpdate.valueAtSource
                let valueString = sourceDataUpdate?.valueStringAtSource || ''
                let valueJson = sourceDataUpdate?.valueJsonAtSource || ''
                if (typeof valueJson !== 'string') valueJson = ''
                let alarmed = fullDocument.alarmed

                // avoid undefined, null or NaN values
                if (value === null || value === undefined || isNaN(value)) {
                  value = 0.0
                  invalid = true
                }

                // Qualifier to be shown in valueString
                let txtQualif = ''
                txtQualif = txtQualif + (invalid ? '[IV]' : '')
                txtQualif = txtQualif + (transient ? '[TR]' : '')
                txtQualif = txtQualif + (overflow ? '[OV]' : '')
                txtQualif = txtQualif + (nottopical ? '[NT]' : '')
                txtQualif = txtQualif + (carry ? '[CR]' : '')
                txtQualif = txtQualif + (substituted ? '[SB]' : '')
                txtQualif = txtQualif + (blocked ? '[BK]' : '')

                if (fullDocument.type === 'digital') {
                  // test for double point status
                  if ('asduAtSource' in sourceDataUpdate) {
                    if (sourceDataUpdate.asduAtSource.indexOf('M_DP_') === 0) {
                      if (value === 0 || value === 3) {
                        transient = true
                        invalid = true
                        if (txtQualif.indexOf('[IV]') < 0)
                          txtQualif = txtQualif + '[IV]'
                        if (txtQualif.indexOf('[TR]') < 0)
                          txtQualif = txtQualif + '[TR]'
                        if (txtQualif !== '') txtQualif = ' ' + txtQualif
                      }
                      value = (value & 0x01) == 0 ? 1 : 0
                    }
                  }

                  // process inversions (kconv1=-1)
                  if (fullDocument.kconv1 === -1)
                    value = value === 0 ? 1 : 0
                  if (
                    value != fullDocument.value &&
                    !fullDocument.alarmDisabled
                  )
                    alarmed = true
                  if (value)
                    valueString =
                      fullDocument.stateTextTrue +
                      (fullDocument.unit != ''
                        ? ' ' + fullDocument.unit
                        : '') +
                      txtQualif
                  else
                    valueString =
                      fullDocument.stateTextFalse +
                      (fullDocument.unit != ''
                        ? ' ' + fullDocument.unit
                        : '') +
                      txtQualif
                } else if (fullDocument.type === 'analog') {
                  if (txtQualif != '') txtQualif = ' ' + txtQualif

                  // apply conversion factors
                  value =
                    sourceDataUpdate.valueAtSource * fullDocument.kconv1 +
                    fullDocument.kconv2

                  if ('zeroDeadband' in fullDocument)
                    if (
                      fullDocument.zeroDeadband !== 0 &&
                      Math.abs(value) < fullDocument.zeroDeadband
                    )
                      value = 0.0

                  valueString =
                    '' +
                    parseFloat(value.toFixed(4)) +
                    ' ' +
                    fullDocument.unit +
                    txtQualif

                  if ('asduAtSource' in sourceDataUpdate)
                    if (sourceDataUpdate.asduAtSource.indexOf('M_BO_') === 0) {
                      // test for bitstring
                      valueString =
                        value.toString(2) +
                        ' ' +
                        fullDocument.unit +
                        txtQualif
                    }

                  let hysteresis = 0
                  if (fullDocument?.hysteresis)
                    hysteresis = parseFloat(fullDocument.hysteresis)

                  // check for limits
                  if (
                    // value != fullDocument.value &&
                    'hiLimit' in fullDocument &&
                    fullDocument.hiLimit !== null &&
                    'loLimit' in fullDocument &&
                    fullDocument.loLimit !== null &&
                    !fullDocument.alarmDisabled
                  ) {
                    if (value > fullDocument.hiLimit + hysteresis) {
                      alarmRange = 1
                    } else if (
                      value <
                      fullDocument.loLimit - hysteresis
                    ) {
                      alarmRange = -1
                    } else if (
                      value < fullDocument.hiLimit - hysteresis &&
                      value > fullDocument.loLimit + hysteresis
                    ) {
                      alarmed = false
                      alarmRange = 0
                    } else if (fullDocument?.alarmRange)
                      // keep the old range if out of range
                      alarmRange = fullDocument.alarmRange

                    // create a SOE entry for the limits alarm/normalization when analog alarm condition changes
                    //if (alarmed != fullDocument.alarmed)
                    //if (
                    //    fullDocument.value <= fullDocument.hiLimit + hysteresis &&
                    //    value > fullDocument.hiLimit + hysteresis
                    //    ||
                    //    fullDocument.value >= fullDocument.hiLimit - hysteresis &&
                    //    value < fullDocument.hiLimit - hysteresis
                    //    ||
                    //    fullDocument.value >= fullDocument.loLimit - hysteresis  &&
                    //    value < fullDocument.loLimit - hysteresis
                    //    ||
                    //    fullDocument.value <= fullDocument.loLimit + hysteresis  &&
                    //    value > fullDocument.loLimit + hysteresis
                    //      )
                    if (!fullDocument.alarmDisabled)
                      if (fullDocument?.alarmRange != alarmRange) {
                        if (alarmRange != 0) alarmed = true
                        const eventDate = new Date()
                        const eventText =
                          parseFloat(value.toFixed(3)) +
                          ' ' +
                          fullDocument.unit +
                          (Math.abs(value) >
                          Math.abs(fullDocument?.value)
                            ? ' ⤉'
                            : Math.abs(value) <
                              Math.abs(fullDocument?.value)
                            ? ' ⤈'
                            : '') +
                          (alarmed ? ' 🚩' : ' 🆗')
                        db.collection(jsConfig.SoeDataCollectionName)
                          .insertOne(
                            {
                              tag: fullDocument.tag,
                              pointKey: fullDocument._id,
                              group1: fullDocument.group1,
                              description: fullDocument.description,
                              eventText: eventText,
                              invalid: false,
                              priority: fullDocument.priority,
                              timeTag: eventDate,
                              timeTagAtSource: eventDate,
                              timeTagAtSourceOk: true,
                              ack: alarmed ? 0 : 1, // enter as acknowledged when normalized
                            },
                            {
                              writeConcern: {
                                w: 0,
                              },
                            }
                          )
                          .catch(function (err) {
                            Log.log('Error on Mongodb query!', err)
                          })
                      }
                  }

                  // analog tags can produce SOE events when marked as isEvent and valid value change, or having source timestamp
                  if (!fullDocument.alarmDisabled)
                    if (
                      (fullDocument?.isEvent === true &&
                        !invalid &&
                        value !== fullDocument?.value) ||
                      isSOE
                    ) {
                      const eventText =
                        parseFloat(value.toFixed(3)) +
                        ' ' +
                        fullDocument.unit +
                        (Math.abs(value) > Math.abs(fullDocument?.value)
                          ? ' ↑'
                          : Math.abs(value) <
                            Math.abs(fullDocument?.value)
                          ? ' ↓'
                          : '')
                      db.collection(jsConfig.SoeDataCollectionName)
                        .insertOne(
                          {
                            tag: fullDocument.tag,
                            pointKey: fullDocument._id,
                            group1: fullDocument.group1,
                            description: fullDocument.description,
                            eventText: eventText,
                            invalid: false,
                            priority: fullDocument.priority,
                            timeTag: new Date(),
                            timeTagAtSource: isSOE
                              ? sourceDataUpdate.timeTagAtSource
                              : new Date(),
                            timeTagAtSourceOk: isSOE
                              ? sourceDataUpdate.timeTagAtSourceOk
                              : false,
                            ack: 1, // enter as acknowledged as it is not an alarm
                          },
                          {
                            writeConcern: {
                              w: 0,
                            },
                          }
                        )
                        .catch(function (err) {
                          Log.log('Error on Mongodb query!', err)
                        })
                    }
                }

                let alarmTime = null
                // if changed to alarmed state, or digital change or soe, register new alarm tag
                if (!fullDocument.alarmDisabled && alarmed) {
                  if (
                    !fullDocument.alarmed ||
                    (fullDocument.type === 'digital' &&
                      value !== fullDocument.value) ||
                    (fullDocument.type === 'digital' && isSOE)
                  ) {
                    alarmTime = new Date()
                  }
                }

                // update only realtimeData if changed or for SOE, must not be historical backfill
                if (
                  (isSOE ||
                    sourceDataUpdate?.rangeCheck ||
                    value !== fullDocument.value && !(!isSOE && fullDocument.type === 'digital' && fullDocument.isEvent === true) ||
                    (fullDocument.type === 'string' && valueString !== fullDocument.valueString) ||
                    (fullDocument.type === 'json' && valueJson !== fullDocument.valueJson) ||
                    sourceDataUpdate?.timeTagAtSource &&
                      (fullDocument?.timeTagAtSource?.getTime() !== sourceDataUpdate.timeTagAtSource.getTime()) ||
                    fullDocument.timeTag === null ||
                    invalid !== fullDocument.invalid) &&
                  !sourceDataUpdate?.isHistorical
                ) {
                  let dt = new Date()

                  if (!fullDocument.alarmDisabled) {
                    if (
                      (alarmed &&
                        isSOE &&
                        fullDocument?.isEvent === true &&
                        fullDocument.type === 'digital' &&
                        value != 0) ||
                      (alarmed &&
                        fullDocument?.isEvent === false &&
                        fullDocument.type === 'digital') ||
                      (alarmed && fullDocument?.alarmed === false)
                    ) {
                      // a new alarm, then update beep var
                      Log.log('NEW BEEP, tag: ' + fullDocument.tag)
                      if (fullDocument.priority === 0)
                        // signal an important beep (for alarm of priority 0)
                        mongoRtDataQueue.enqueue({
                          _id: beepPointKey,
                          beepType: new Double(2), // this is an important beep
                          value: new Double(1),
                          valueString: 'Beep Active',
                          timeTag: dt,
                          $addToSet: {
                            beepGroup1List: fullDocument.group1,
                          },
                        })
                      else if (
                        fullDocument.priority <= LowestPriorityThatBeeps
                      )
                        mongoRtDataQueue.enqueue({
                          _id: beepPointKey,
                          value: new Double(1),
                          valueString: 'Beep Active',
                          timeTag: dt,
                          $addToSet: {
                            beepGroup1List: fullDocument.group1,
                          },
                        })
                    }
                    if (fullDocument.type === 'digital') {
                      digitalUpdatesCount++
                      mongoRtDataQueue.enqueue({
                        _id: cntUpdatesPointKey,
                        value: new Double(digitalUpdatesCount),
                        valueString: '' + digitalUpdatesCount + ' Updates',
                        timeTag: dt,
                      })
                    }
                  }

                  // historianPeriod<0 or update is not for historical record, excludes from historian
                  let insertIntoHistorian = true
                  if ('historianPeriod' in fullDocument) {
                    if (
                      fullDocument.historianPeriod < 0 ||
                      sourceDataUpdate?.isNotForHistorical
                    ) {
                      insertIntoHistorian = false
                    } else {
                      // historianPeriod >= 0, will test dead band for analogs
                      if (
                        fullDocument?.type === 'analog' &&
                        'historianDeadBand' in fullDocument
                      ) {
                        if (
                          'historianLastValue' in fullDocument &&
                          fullDocument.historianLastValue !== null &&
                          fullDocument.historianDeadBand > 0
                        ) {
                          // test for variation less than absolute dead band
                          if (
                            Math.abs(
                              value - fullDocument.historianLastValue
                            ) < Math.abs(fullDocument.historianDeadBand)
                          ) {
                            insertIntoHistorian = false
                          }
                        }
                      }
                    }
                  }

                  let update = {
                    _id: fullDocument._id,
                    value: new Double(value),
                    valueString: valueString,
                    valueJson: valueJson,
                    ...(fullDocument?.type === 'analog' &&
                    insertIntoHistorian
                      ? { historianLastValue: new Double(value) }
                      : {}),
                    timeTag: dt,
                    overflow: overflow,
                    invalid: invalid,
                    transient: transient,
                    frozen: false,
                    timeTagAtSource: null,
                    timeTagAtSourceOk: null,
                    updatesCnt: new Double(fullDocument.updatesCnt + 1),
                    alarmRange: new Double(alarmRange),
                    alarmed:
                      fullDocument?.alarmDisabled === true
                        ? false
                        : alarmed,
                  }
                  if (alarmTime !== null) update.timeTagAlarm = alarmTime

                  // update source time when available
                  if (
                    'timeTagAtSource' in sourceDataUpdate &&
                    sourceDataUpdate.timeTagAtSource !== null
                  ) {
                    update.timeTagAtSource = sourceDataUpdate.timeTagAtSource
                    update.timeTagAtSourceOk =
                      sourceDataUpdate.timeTagAtSourceOk
                  }

                  // do not update protection-like events for state OFF, do not update when not for historical backfill
                  if (
                    !(
                      fullDocument.isEvent &&
                      fullDocument.type === 'digital' &&
                      value === 0 &&
                      !sourceDataUpdate?.isHistorical
                    )
                  ) {
                    mongoRtDataQueue.enqueue(update)

                    Log.log(
                      'UPD ' +
                        fullDocument._id +
                        ' ' +
                        fullDocument.tag +
                        ' ' +
                        value +
                        ' DELAY ' +
                        (new Date().getTime() -
                          sourceDataUpdate.timeTag.getTime()) +
                        'ms',
                      Log.levelDetailed
                    )
                  }

                  // build sql values list for queued insert into historian
                  // Fields: tag, time_tag, value, value_json, time_tag_at_source, flags
                  if (insertIntoHistorian) {
                    // queue data change for postgresql historian
                    let b7 = invalid ? '1' : '0', // value invalid
                      b6 =
                        update.timeTagAtSourceOk !== null
                          ? update.timeTagAtSourceOk
                            ? '0'
                            : '1'
                          : '1', // time tag at source invalid
                      b5 = fullDocument.type === 'analog' ? '1' : '0', // analog
                      b4 =
                        sourceDataUpdate.causeOfTransmissionAtSource === '20'
                          ? '1'
                          : '0', // integrity?
                      b3 = '0', // reserved
                      b2 = '0', // reserved
                      b1 = '0', // reserved
                      b0 = '0' // reserved
                    let vj =
                      valueJson === ''
                        ? '""'
                        : valueJson.trim().replaceAll("'", "''")
                    let trimS = ''
                    if (vj.length > 0) {
                      if (vj.charAt(0) === '{' || vj.charAt(0) === '[')
                        trimS = '"'
                      else if (isNaN(vj) && vj.charAt(0) !== '"')
                        vj = '"' + vj + '"'
                    }
                    const vs =
                      valueString === ''
                        ? ''
                        : valueString.replaceAll("'", "''")
                    sqlHistQueue.enqueue({
                      sql:
                        "'" +
                        fullDocument.tag.replaceAll("'", "''") +
                        "'," +
                        "'" +
                        sourceDataUpdate.timeTag.toISOString() +
                        "'," +
                        value +
                        `,('{"v":'||trim('${trimS}' FROM to_json('${vj}'::text)::jsonb #>> '{}')||',"s":'||to_json('${vs}'::text)||'}'::text)::jsonb,` +
                        (update.timeTagAtSource !== null
                          ? "'" +
                            sourceDataUpdate.timeTagAtSource.toISOString() +
                            "'"
                          : 'null') +
                        ',' +
                        "B'" +
                        b7 +
                        b6 +
                        b5 +
                        b4 +
                        b3 +
                        b2 +
                        b1 +
                        b0 +
                        "'",
                      obj: {
                        tag: fullDocument.tag,
                        timeTag: sourceDataUpdate.timeTag,
                        value:
                          fullDocument.type === 'string'
                            ? valueString
                            : fullDocument.type === 'json'
                            ? valueJson
                            : value,
                        invalid: invalid,
                        ...(update.timeTagAtSource !== null
                          ? { timeTagAtSource: update.timeTagAtSource }
                          : {}),
                        ...(update.timeTagAtSourceOk !== null
                          ? { timeTagAtSourceOk: update.timeTagAtSourceOk }
                          : {}),
                        ...(sourceDataUpdate?.causeOfTransmissionAtSource
                          ? {
                              cot: sourceDataUpdate.causeOfTransmissionAtSource,
                            }
                          : {}),
                      },
                    })
                  }

                  // update fullDocument with new data just to stringify it and queue update for postgresql update
                  fullDocument.value = value
                  fullDocument.valueString = valueString
                  fullDocument.valueJson = valueJson
                  fullDocument.timeTag = dt
                  fullDocument.overflow = overflow
                  fullDocument.invalid = invalid
                  fullDocument.transient = transient
                  fullDocument.updatesCnt =
                    fullDocument.updatesCnt + 1
                  fullDocument.alarmed = alarmed
                  let queueStr =
                    "'" +
                    fullDocument.tag.replaceAll("'", "''") +
                    "'," +
                    "'" +
                    new Date().toISOString() +
                    "'," +
                    "'" +
                    JSON.stringify(fullDocument).replaceAll("'", "''") +
                    "'"
                  sqlRtDataQueue.enqueue(queueStr)
                } else
                  Log.log(
                    'Not changed ' +
                      fullDocument.tag +
                      ' DELAY ' +
                      (new Date().getTime() -
                        sourceDataUpdate.timeTag.getTime()) +
                      'ms',
                    Log.levelDetailed
                  )

                // prepare update to soeData collection, do not put into SOE when alarm disabled or update is not for historical record
                if (
                  isSOE &&
                  fullDocument.type !== 'analog' &&
                  !fullDocument.alarmDisabled &&
                  !sourceDataUpdate?.isNotForHistorical
                )
                  if (!(value === 0 && fullDocument.isEvent)) {
                    let eventText = fullDocument.eventTextFalse
                    if (value !== 0) {
                      eventText = fullDocument.eventTextTrue
                    }

                    db.collection(jsConfig.SoeDataCollectionName)
                      .insertOne(
                        {
                          tag: fullDocument.tag,
                          pointKey: fullDocument._id,
                          group1: fullDocument.group1,
                          description: fullDocument.description,
                          eventText: eventText,
                          invalid: invalid,
                          priority: fullDocument.priority,
                          timeTag: new Date(),
                          timeTagAtSource: sourceDataUpdate.timeTagAtSource,
                          timeTagAtSourceOk: sourceDataUpdate.timeTagAtSourceOk,
                          ack: 0,
                        },
                        {
                          writeConcern: {
                            w: 0,
                          },
                        }
                      )
                      .catch(function (err) {
                        Log.log('Error on Mongodb query!', err)
                      })
                    Log.log(
                      'SOE ' +
                        fullDocument._id +
                        ' ' +
                        fullDocument.tag +
                        ' ' +
                        sourceDataUpdate.valueAtSource +
                        ' ' +
                        sourceDataUpdate.timeTagAtSource,
                      Log.levelDetailed
                    )
                  }
              } catch (e) {
                Log.log(e)
              }
            })
          } catch (e) {
            if (resumeToken !== null && resumeToken === prevResumeToken) {
              // if resumeToken is the same, it means the error is not recoverable, so cancel the resumeToken
              prevResumeToken = null
              resumeToken = null
            }
            prevResumeToken = resumeToken
            if (clientMongo) clientMongo.close()
            clientMongo = null
            Log.log('Error on ChangeStream!!')
            Log.log(e)
          }
        })
        .catch(function (err) {
          if (clientMongo) clientMongo.close()
          clientMongo = null
          Log.log(err)
        })

    // wait 5 seconds
    await new Promise((resolve) => setTimeout(resolve, 5000))

    // detect connection problems, if error will null the client to later reconnect
    if (clientMongo === undefined) {
      Log.log('Disconnected Mongodb!')
      clientMongo = null
    }
    if (clientMongo)
      if (!(await checkConnectedMongo(clientMongo))) {
        // not anymore connected, will retry
        Log.log('Disconnected Mongodb!')
        if (clientMongo) clientMongo.close()
        clientMongo = null
      }
  }
})()

// test mongoDB connectivity
async function checkConnectedMongo(client) {
  if (!client) {
    return false
  }
  const CheckMongoConnectionTimeout = 10000
  let tr = setTimeout(() => {
    Log.log('Mongo ping timeout error!')
    MongoStatus.HintMongoIsConnected = false
  }, CheckMongoConnectionTimeout)

  let res = null
  try {
    res = await client.db('admin').command({ ping: 1 })
  } catch (e) {
    Log.log('Error on mongodb connection!')
    return false
  } finally {
    clearTimeout(tr)
  }
  if ('ok' in res && res.ok) {
    MongoStatus.HintMongoIsConnected = true
    return true
  } else {
    if (!!client && !!client.topology && client.topology.isConnected())
      return true
    MongoStatus.HintMongoIsConnected = false
    return false
  }
}

async function createSpecialTags(collection) {
  // insert special tags when not found
  let results = await collection.find({ _id: beepPointKey }).toArray()
  if (results && results.length == 0) {
    collection
      .insertOne({
        _id: new Double(beepPointKey),
        alarmRange: new Double(0.0),
        alarmDisabled: true,
        alarmState: new Double(1.0),
        alarmed: false,
        annotation: '',
        commandBlocked: false,
        commandOfSupervised: new Double(0.0),
        description: '_System~Status~Alarm Beep',
        eventTextFalse: 'Beep Deactivated',
        eventTextTrue: 'Beep Activated',
        formula: null,
        frozen: false,
        frozenDetectTimeout: new Double(300.0),
        group1: '_System',
        group2: 'Status',
        group3: '',
        hiLimit: null,
        hihiLimit: null,
        hihihiLimit: null,
        historianDeadBand: new Double(0.0),
        historianPeriod: new Double(0.0),
        hysteresis: new Double(0.0),
        invalid: true,
        invalidDetectTimeout: new Double(0.0),
        isEvent: false,
        kconv1: new Double(1.0),
        kconv2: new Double(0.0),
        loLimit: null,
        location: null,
        loloLimit: null,
        lololoLimit: null,
        notes: '',
        origin: 'system',
        overflow: false,
        parcels: null,
        priority: new Double(3.0),
        protocolSourceASDU: new Double(0.0),
        protocolSourceCommandDuration: null,
        protocolSourceCommandUseSBO: null,
        protocolSourceCommonAddress: new Double(0.0),
        protocolSourceConnectionNumber: new Double(0.0),
        protocolSourceObjectAddress: new Double(0.0),
        sourceDataUpdate: null,
        stateTextFalse: 'No Beep',
        stateTextTrue: 'Active Beep',
        substituted: false,
        supervisedOfCommand: new Double(0.0),
        tag: '_System.Status.AlarmBeep',
        timeTag: new Date('2000-01-01T00:00:00.000Z'),
        transient: false,
        type: 'analog',
        ungroupedDescription: 'Alarm Beep',
        unit: 'Enum',
        updatesCnt: new Double(0.0),
        value: new Double(0.0),
        valueDefault: new Double(0.0),
        valueString: 'No Beep',
        timeTagAtSource: null,
        timeTagAtSourceOk: null,
        beepType: new Double(0.0),
        beepGroup1List: [],
      })
      .catch(function (err) {
        Log.log('Error on Mongodb query!', err)
      })
  } else {
    await collection.updateOne(
      { _id: beepPointKey, beepGroup1List: { $exists: false } },
      { $set: { beepGroup1List: [] } }
    )
  }
  results = await collection.find({ _id: cntUpdatesPointKey }).toArray()
  if (results && results.length == 0) {
    collection
      .insertOne({
        _id: new Double(cntUpdatesPointKey),
        alarmRange: new Double(0),
        alarmDisabled: true,
        alarmState: new Double(1.0),
        alarmed: false,
        annotation: '',
        commandBlocked: false,
        commandOfSupervised: new Double(0.0),
        description: '_System~Status~Digital Updates Count',
        eventTextFalse: '',
        eventTextTrue: '',
        formula: null,
        frozen: false,
        frozenDetectTimeout: new Double(300.0),
        group1: '_System',
        group2: 'Status',
        group3: '',
        hiLimit: null,
        hihiLimit: null,
        hihihiLimit: null,
        historianDeadBand: new Double(0.0),
        historianPeriod: new Double(0.0),
        hysteresis: new Double(0.0),
        invalid: true,
        invalidDetectTimeout: new Double(0.0),
        isEvent: false,
        kconv1: new Double(1.0),
        kconv2: new Double(0.0),
        loLimit: null,
        location: null,
        loloLimit: null,
        lololoLimit: null,
        notes: '',
        origin: 'system',
        overflow: false,
        parcels: null,
        priority: new Double(3.0),
        protocolSourceASDU: new Double(0.0),
        protocolSourceCommandDuration: null,
        protocolSourceCommandUseSBO: null,
        protocolSourceCommonAddress: new Double(0.0),
        protocolSourceConnectionNumber: new Double(0.0),
        protocolSourceObjectAddress: new Double(0.0),
        sourceDataUpdate: null,
        stateTextFalse: '',
        stateTextTrue: '',
        substituted: false,
        supervisedOfCommand: new Double(0.0),
        tag: '_System.Status.DigitalUpdatesCnt',
        timeTag: new Date('2000-01-01T00:00:00.000Z'),
        transient: false,
        type: 'analog',
        ungroupedDescription: 'Digital Updates Count',
        unit: 'Updates',
        updatesCnt: new Double(0.0),
        value: new Double(0.0),
        valueDefault: new Double(0.0),
        valueString: '0 Updates',
        timeTagAtSource: null,
        timeTagAtSourceOk: null,
      })
      .catch(function (err) {
        Log.log('Error on Mongodb query!', err)
      })
  }
}
