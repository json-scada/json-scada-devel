/*
 * A process that converts Grafana alert notifications into JSON-SCADA SOE events, alarms and beeps.
 * Supports the Grafana Alerting webhook payload (Grafana >= 8, unified alerting).
 * The legacy (pre-Grafana 8) webhook notification payload is still accepted for backward compatibility.
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

'use strict'

const USERNAME = process.env.JS_ALERT2EVENT_USERNAME || 'grafana'
const PASSWORD = process.env.JS_ALERT2EVENT_PASSWORD || 'grafana'
const ALERTING_MSG = process.env.JS_ALERT2EVENT_ALERTING_MSG || 'alerting'
const OK_MSG = process.env.JS_ALERT2EVENT_OK_MSG || 'ok'

const IP_BIND = process.env.JS_ALERT2EVENT_IP_BIND || '127.0.0.1'
const HTTP_PORT = process.env.JS_ALERT2EVENT_HTTP_PORT || 51910
const API_URL = '/grafana_alert2event'

const APP_NAME = 'GRAFANA_ALERT2EVENT'
const APP_MSG = '{json:scada} - Grafana Alert To Event Listener'
const VERSION = '0.2.0'
const RealtimeDataCollectionName = 'realtimeData'
const SoeCollectionName = 'soeData'
const NO_TAG_TAG_NAME = '_NO_TAG_'
const beepPointKey = -1

var jsConfigFile = '../../conf/json-scada.json'
const Queue = require('queue-fifo')
const fs = require('fs')
const mongo = require('mongodb')
const { MongoClient, ReadPreference } = require('mongodb')
const { setInterval } = require('timers')
const express = require('express')
const app = express()
app.use(express.json())
let soeQueue = new Queue() // queue of SOE events

process.on('uncaughtException', (err) =>
  console.log('Uncaught Exception:' + JSON.stringify(err))
)

app.listen(HTTP_PORT, IP_BIND, () => {
  console.log('listening on ' + IP_BIND + ':' + HTTP_PORT)
})

async function basicAuth(req, res, next) {
  // check for basic auth header
  if (
    !req.headers.authorization ||
    req.headers.authorization.indexOf('Basic ') === -1
  ) {
    return res.status(401).json({ message: 'Missing Authorization Header' })
  }

  // verify auth credentials
  const base64Credentials = req.headers.authorization.split(' ')[1]
  const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii')
  const [username, password] = credentials.split(':')
  const user = await validateCredentials({ username, password })
  if (!user) {
    // console.log("Invalid user credentials!")
    return res
      .status(401)
      .json({ message: 'Invalid Authentication Credentials' })
  }

  // console.log("Authorized user.")

  // attach user to request object
  req.user = user
  next()
}

async function validateCredentials(cred) {
  if (cred.username === USERNAME && cred.password === PASSWORD)
    return { username: cred.username }
  return false
}

app.use(basicAuth)

// Extract the list of alerts from the notification body.
// Grafana Alerting (>= 8) groups one or more alerts in the "alerts" array.
// A legacy (pre-8) notification body is converted to an equivalent single alert.
function extractAlerts(body) {
  if (Array.isArray(body?.alerts)) return body.alerts

  // legacy payload: { state, tags, evalMatches, message, ruleUrl }
  if (['ok', 'alerting'].includes(body?.state)) {
    const labels = Object.assign({}, body?.tags)
    if (!labels.tag && body?.evalMatches?.[0]?.metric)
      labels.tag = body.evalMatches[0].metric
    return [
      {
        status: body.state === 'alerting' ? 'firing' : 'resolved',
        labels: labels,
        annotations: { summary: body?.message },
        generatorURL: body?.ruleUrl,
      },
    ]
  }
  return []
}

// API access point for the Grafana webhook contact point
app.post(API_URL, function (req, res) {
  res.setHeader('Content-Type', 'application/json')

  console.log(JSON.stringify(req.body))

  const alerts = extractAlerts(req.body)
  if (alerts.length === 0)
    console.log('No alerts found in notification, discarding.')

  for (const alert of alerts) {
    if (!['firing', 'resolved'].includes(alert?.status)) {
      console.log('Discard alert. Status: ' + alert?.status)
      continue
    }

    const labels = alert?.labels || {}
    const annotations = alert?.annotations || {}
    const isFiring = alert.status === 'firing'
    const createEvent = labels?.event !== '0'
    const createAlarm = labels?.alarm !== '0'
    if (!createEvent && !createAlarm) {
      console.log('Discard alert. Event and alarm conversion disabled by labels.')
      continue
    }

    const timeStamp = new Date()

    // time of the state change at the source (startsAt when firing, endsAt when resolved)
    let timeTagAtSource = timeStamp
    let timeTagAtSourceOk = false
    const srcDate = new Date(isFiring ? alert?.startsAt : alert?.endsAt)
    if (!isNaN(srcDate.getTime()) && srcDate.getTime() > 0) {
      timeTagAtSource = srcDate
      timeTagAtSourceOk = true
    }

    const tag = labels?.tag || labels?.alertname || NO_TAG_TAG_NAME
    const priority = new mongo.Double(parseFloat(labels?.priority || 3))
    const group1 = labels?.group1 || 'Grafana'
    const pointKey = new mongo.Double(parseFloat(labels?.pointKey || 0))
    let eventText = isFiring ? ALERTING_MSG : OK_MSG
    if (isFiring && 'alertingText' in labels) eventText = labels.alertingText
    if (!isFiring && 'okText' in labels) eventText = labels.okText

    const description =
      annotations?.summary ||
      annotations?.description ||
      req.body?.title ||
      req.body?.message ||
      ''

    const SOE_Event = {
      tag: tag,
      pointKey: pointKey,
      group1: group1,
      description: description,
      eventText: eventText,
      invalid: false,
      priority: priority,
      timeTag: timeStamp,
      timeTagAtSource: timeTagAtSource,
      timeTagAtSourceOk: timeTagAtSourceOk,
      ack: 0,
      source: alert?.generatorURL || req.body?.externalURL || '',
      alertState: isFiring ? 'alerting' : 'ok',
    }
    soeQueue.enqueue({
      event: SOE_Event,
      createEvent: createEvent,
      createAlarm: createAlarm,
    })
    console.log(SOE_Event)
  }

  res.send({ ok: true })
})

const args = process.argv.slice(2)
var confFile = null
if (args.length > 0) confFile = args[0]
jsConfigFile = confFile || process.env.JS_CONFIG_FILE || jsConfigFile

console.log(APP_MSG + ' Version ' + VERSION)
console.log('Config File: ' + jsConfigFile)

if (!fs.existsSync(jsConfigFile)) {
  console.log('Error: config file not found!')
  process.exit()
}

let rawFileContents = fs.readFileSync(jsConfigFile)
let jsConfig = JSON.parse(rawFileContents)
if (
  typeof jsConfig.mongoConnectionString != 'string' ||
  jsConfig.mongoConnectionString === ''
) {
  console.log('Error reading config file.')
  process.exit()
}

;(async () => {
  let connOptions = {
    appName: APP_NAME + ' Version:' + VERSION,
    maxPoolSize: 20,
    readPreference: ReadPreference.PRIMARY,
  }

  if (
    typeof jsConfig.tlsCaPemFile === 'string' &&
    jsConfig.tlsCaPemFile.trim() !== ''
  ) {
    jsConfig.tlsClientKeyPassword = jsConfig.tlsClientKeyPassword || ''
    jsConfig.tlsAllowInvalidHostnames =
      jsConfig.tlsAllowInvalidHostnames || false
    jsConfig.tlsAllowChainErrors = jsConfig.tlsAllowChainErrors || false
    jsConfig.tlsInsecure = jsConfig.tlsInsecure || false

    connOptions.tls = true
    connOptions.tlsCAFile = jsConfig.tlsCaPemFile
    connOptions.tlsCertificateKeyFile = jsConfig.tlsClientPemFile
    connOptions.tlsCertificateKeyFilePassword = jsConfig.tlsClientKeyPassword
    connOptions.tlsAllowInvalidHostnames = jsConfig.tlsAllowInvalidHostnames
    connOptions.tlsInsecure = jsConfig.tlsInsecure
  }

  let clientMongo = null
  let checkSoeQueueIntervalHandle = null
  while (true) {
    if (clientMongo === null) {
      console.log('Try to connect to MongoDB server...')
      await MongoClient.connect(jsConfig.mongoConnectionString, connOptions)
        .then(async (client) => {
          clientMongo = client
          console.log('Connected correctly to MongoDB server')

          // specify db and collections
          const db = client.db(jsConfig.mongoDatabaseName)

          // check for event queue each 1s, insert into mongo when dequeued
          clearInterval(checkSoeQueueIntervalHandle)
          checkSoeQueueIntervalHandle = setInterval(async function () {
            if (clientMongo) {
              while (!soeQueue.isEmpty()) {
                try {
                  let res
                  const { event, createEvent, createAlarm } = soeQueue.peek()
                  soeQueue.dequeue()

                  if (createEvent) {
                    console.log('Insert SOE')
                    const coll_soe = db.collection(SoeCollectionName)
                    res = await coll_soe.insertOne(event)
                    if (res.acknowledged)
                      console.log('MongoDB - Document inserted')
                    else console.log('MongoDB - Error inserting Document')
                  }

                  if (!createAlarm) continue

                  const coll_rtData = db.collection(RealtimeDataCollectionName)

                  // update beep if it is alerting state
                  if (event.alertState === 'alerting') {
                    console.log('Update beep')
                    res = await coll_rtData.updateOne(
                      // new beep
                      { _id: beepPointKey },
                      {
                        $set: {
                          value: new mongo.Double(1),
                          valueString: 'Beep Active',
                          timeTag: new Date(),
                        },
                      }
                    )
                    console.log(
                      `${res.matchedCount} document(s) matched the filter, updated ${res.modifiedCount} document(s)`
                    )
                  }

                  // if event has a tag, signal alarm in that point (even when alarm is disabled)
                  // Grafana alerts can not be disabled in JSON-SCADA viewers, only can be disabled in Grafana UI
                  if (event.tag !== NO_TAG_TAG_NAME) {
                    console.log('Update alert')
                    let where = { tag: event.tag }
                    let upd = {
                      $set: {
                        alerted: event.alertState === 'alerting',
                        alertState: event.alertState,
                        timeTagAlertState: event.timeTag,
                      },
                    }

                    res = await coll_rtData.updateOne(where, upd)
                    console.log(event.eventText)
                    console.log(where)
                    console.log(upd)
                    console.log(
                      `${res.matchedCount} document(s) matched the filter, updated ${res.modifiedCount} document(s)`
                    )
                  }
                } catch (e) {
                  console.log(e)
                }
              }
            }
          }, 1000)
        })
        .catch(function (err) {
          if (clientMongo) clientMongo.close()
          clientMongo = null
          console.log('Connect to MongoDB error!' + err)
        })
    }

    // wait 5 seconds
    await new Promise((resolve) => setTimeout(resolve, 5000))

    if (!(await checkConnectedMongo(clientMongo))) {
      clientMongo = null
    }

    // detect connection problems, if error will null the client to later reconnect
    if (clientMongo === undefined) {
      console.log('Disconnected Mongodb!')
      clientMongo = null
    }
    if (!HintMongoIsConnected) {
      // not anymore connected, will retry
      console.log('Disconnected Mongodb!')
      if (clientMongo) clientMongo.close()
      clientMongo = null
    }
  }
})()

// test mongoDB connectivity
let CheckMongoConnectionTimeout = 10000
let HintMongoIsConnected = true
async function checkConnectedMongo(client) {
  if (!client) {
    return false
  }

  let tr = setTimeout(() => {
    console.log('Mongo ping timeout error!')
    HintMongoIsConnected = false
  }, CheckMongoConnectionTimeout)

  let res = null
  try {
    res = await client.db('admin').command({ ping: 1 })
    clearTimeout(tr)
  } catch (e) {
    console.log('Error on mongodb connection!')
    return false
  }
  if ('ok' in res && res.ok) {
    HintMongoIsConnected = true
    return true
  } else {
    HintMongoIsConnected = false
    return false
  }
}
