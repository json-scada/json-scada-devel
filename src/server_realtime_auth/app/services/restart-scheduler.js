/*
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

// Debounced per-instance restart scheduler. Connection edits call scheduleRestart();
// rapid bursts (bulk edits, imports) coalesce into a single driver restart. When
// auto-restart is disabled the instance is instead flagged "restart pending" so the
// UI can offer a manual restart.

'use strict'

const db = require('../models')
const ProcessManager = require('./process-manager')
const Log = require('../../simple-logger')

const ProtocolDriverInstance = db.protocolDriverInstance

const DEBOUNCE_MS = 5000
const timers = new Map() // key -> timeout
const pending = new Set() // keys flagged for manual restart

function keyOf(driver, instanceNumber) {
  return driver + '#' + Math.trunc(Number(instanceNumber))
}

async function loadInstance(driver, instanceNumber) {
  return ProtocolDriverInstance.findOne({
    protocolDriver: driver,
    protocolDriverInstanceNumber: Math.trunc(Number(instanceNumber)),
  })
    .lean()
    .exec()
}

// Schedules (or reschedules) a debounced restart of the driver owning a connection.
// Returns { scheduled } / { pending } / { skipped } describing what will happen so the
// caller can inform the UI.
async function scheduleRestart(driver, instanceNumber, autoRestart) {
  if (!driver || driver === 'UNDEFINED') return { skipped: true }
  const key = keyOf(driver, instanceNumber)

  const inst = await loadInstance(driver, instanceNumber)
  if (!inst) return { skipped: true, reason: 'instance not found' }

  const m = ProcessManager.isManageable(inst)
  if (!m.manageable) return { skipped: true, reason: m.reason }
  if (inst.enabled === false) return { skipped: true, reason: 'instance disabled' }

  const instAuto =
    inst.processManagement?.autoRestartOnConfigChange !== false && autoRestart

  if (!instAuto) {
    pending.add(key)
    return { pending: true }
  }

  if (timers.has(key)) clearTimeout(timers.get(key))
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key)
      pending.delete(key)
      fireRestart(driver, instanceNumber)
    }, DEBOUNCE_MS)
  )
  return { scheduled: true, delayMs: DEBOUNCE_MS }
}

async function fireRestart(driver, instanceNumber) {
  try {
    const inst = await loadInstance(driver, instanceNumber)
    if (!inst) return
    const st = await ProcessManager.status(inst)
    if (!st.installed || st.state !== 'RUNNING') return // only restart a running service
    Log.log('Auto-restart driver ' + keyOf(driver, instanceNumber))
    await ProcessManager.restart(inst)
  } catch (err) {
    Log.log('Auto-restart error: ' + err.message)
  }
}

function isPending(driver, instanceNumber) {
  return pending.has(keyOf(driver, instanceNumber))
}

function clearPending(driver, instanceNumber) {
  pending.delete(keyOf(driver, instanceNumber))
}

function pendingKeys() {
  return [...pending]
}

module.exports = {
  scheduleRestart,
  isPending,
  clearPending,
  pendingKeys,
  keyOf,
}
