/*
 * {json:scada} - Copyright (c) 2020-2024 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * Auto-creation of supervised tags for values pushed from n8n into the driver.
 * Adapted from the telegraf-listener / mqtt-sparkplug drivers.
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

const { Double } = require('mongodb')
const AppDefs = require('./app-defs')

// infer a JSON-SCADA point type from a JS value pushed by n8n
// number -> analog, boolean -> digital, object -> json, other -> string
function inferType(value) {
  if (typeof value === 'boolean') return 'digital'
  if (typeof value === 'number' && !isNaN(value)) return 'analog'
  if (value !== null && typeof value === 'object') return 'json'
  if (
    typeof value === 'string' &&
    value.trim() !== '' &&
    !isNaN(parseFloat(value)) &&
    isFinite(value)
  )
    return 'analog'
  return 'string'
}

// numeric coercion for the analog/digital value fields (Double is required by schema)
function numericValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return isNaN(value) ? 0 : value
  let f = parseFloat(value)
  return isNaN(f) ? 0 : f
}

// build a realtimeData document for a newly seen n8n point
function NewTag(measurement, connectionNumber, autoKeyId, connectionName) {
  const type = inferType(measurement.value)
  const tag = measurement.tag
  return {
    _id: new Double(autoKeyId),
    protocolSourceASDU: '',
    protocolSourceCommonAddress: '',
    protocolSourceConnectionNumber: new Double(connectionNumber),
    protocolSourceObjectAddress: tag,
    protocolSourceCommandDuration: new Double(0),
    protocolSourceCommandUseSBO: false,
    alarmState: new Double(-1.0),
    alarmRange: new Double(0.0),
    description:
      measurement.description || (connectionName ? connectionName + '~' : '') + tag,
    ungroupedDescription: measurement.ungroupedDescription || tag,
    group1: measurement.group1 || connectionName || '',
    group2: measurement.group2 || '',
    group3: measurement.group3 || '',
    stateTextFalse: '',
    stateTextTrue: '',
    eventTextFalse: '',
    eventTextTrue: '',
    origin: 'supervised',
    tag: tag,
    type: type,
    value: new Double(numericValue(measurement.value)),
    valueString:
      type === 'json'
        ? JSON.stringify(measurement.value)
        : String(measurement.value),
    valueJson: type === 'json' ? measurement.value : {},
    alarmDisabled: false,
    alerted: false,
    alarmed: false,
    alertState: '',
    annotation: '',
    commandBlocked: false,
    commandOfSupervised: new Double(0.0),
    commissioningRemarks: 'Auto created by ' + AppDefs.NAME,
    formula: new Double(0.0),
    frozen: false,
    frozenDetectTimeout: new Double(0.0),
    hiLimit: new Double(Number.MAX_VALUE),
    hihiLimit: new Double(Number.MAX_VALUE),
    hihihiLimit: new Double(Number.MAX_VALUE),
    historianDeadBand: new Double(0.0),
    historianPeriod: new Double(0.0),
    hysteresis: new Double(0.0),
    invalid: measurement?.invalid ? true : false,
    invalidDetectTimeout: new Double(60000.0),
    isEvent: false,
    kconv1: new Double(1.0),
    kconv2: new Double(0.0),
    location: null,
    loLimit: new Double(-Number.MAX_VALUE),
    loloLimit: new Double(-Number.MAX_VALUE),
    lololoLimit: new Double(-Number.MAX_VALUE),
    notes: '',
    overflow: false,
    parcels: null,
    priority: new Double(0.0),
    protocolDestinations: null,
    sourceDataUpdate: null,
    substituted: false,
    supervisedOfCommand: new Double(0.0),
    timeTag: null,
    timeTagAlarm: null,
    timeTagAtSource: measurement.timeTagAtSource
      ? new Date(measurement.timeTagAtSource)
      : null,
    timeTagAtSourceOk: false,
    transient: false,
    unit: measurement.unit || '',
    updatesCnt: new Double(0.0),
    valueDefault: new Double(0.0),
    zeroDeadband: new Double(0.0),
  }
}

// build the sourceDataUpdate patch for an incoming value
function SourceDataUpdate(measurement, connectionNumber) {
  const type = inferType(measurement.value)
  let valueJson = null
  if (type === 'json') valueJson = measurement.value
  else {
    // best-effort parse of stringified JSON
    try {
      valueJson = JSON.parse(measurement.value)
    } catch (e) {}
  }
  return {
    valueAtSource: numericValue(measurement.value),
    valueStringAtSource:
      type === 'json'
        ? JSON.stringify(measurement.value)
        : String(measurement.value),
    valueJsonAtSource: valueJson,
    asduAtSource: '',
    causeOfTransmissionAtSource: '3',
    timeTagAtSource: measurement.timeTagAtSource
      ? new Date(measurement.timeTagAtSource)
      : new Date(),
    timeTagAtSourceOk: measurement.timeTagAtSourceOk === true,
    timeTag: new Date(),
    originator: AppDefs.NAME + '|' + connectionNumber,
    notTopicalAtSource: false,
    invalidAtSource: measurement.invalid === true,
    overflowAtSource: false,
    blockedAtSource: false,
    substitutedAtSource: false,
  }
}

// find the biggest _id currently used in this connection's key partition
async function GetAutoKeyInitialValue(rtCollection, connectionNumber) {
  let autoKeyId = connectionNumber * AppDefs.AUTOKEY_MULTIPLIER
  let resLastKey = await rtCollection
    .find({
      _id: {
        $gt: autoKeyId,
        $lt: (connectionNumber + 1) * AppDefs.AUTOKEY_MULTIPLIER,
      },
    })
    .sort({ _id: -1 })
    .limit(1)
    .toArray()
  if (resLastKey.length > 0 && '_id' in resLastKey[0]) {
    if (parseInt(resLastKey[0]._id) >= autoKeyId)
      autoKeyId = parseInt(resLastKey[0]._id)
  }
  return autoKeyId
}

module.exports = {
  inferType,
  numericValue,
  NewTag,
  SourceDataUpdate,
  GetAutoKeyInitialValue,
}
