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

// HTTP endpoints for protocol driver service management: start / stop / restart a
// single instance, bulk status for the AdminUI table, sync/reconcile, and the global
// settings toggles. All routes are admin-only (wired in auth.routes.js).

'use strict'

const Log = require('../../simple-logger')
const db = require('../models')
const UserActionsQueue = require('../../userActionsQueue')
const { checkToken } = require('../middlewares/authJwt')
const ProcessManager = require('../services/process-manager')
const RestartScheduler = require('../services/restart-scheduler')
const SystemSettings = require('../services/system-settings')

const ProtocolDriverInstance = db.protocolDriverInstance

function registerUserAction(req, actionName) {
  const body = {}
  Object.assign(body, req.body)
  delete body['password']
  const ck = checkToken(req)
  UserActionsQueue.enqueue({
    username: ck ? ck.username : req.body?.username,
    properties: body,
    action: actionName,
    timeTag: new Date(),
  })
}

// Resolves the full instance document referenced by a request body.
async function resolveInstance(req) {
  const q = {}
  if (req.body?._id) q._id = req.body._id
  else {
    q.protocolDriver = req.body?.protocolDriver
    q.protocolDriverInstanceNumber = Math.trunc(
      Number(req.body?.protocolDriverInstanceNumber)
    )
  }
  return ProtocolDriverInstance.findOne(q).lean().exec()
}

function actionHandler(actionName, opName) {
  return async (req, res) => {
    Log.log(actionName)
    try {
      const inst = await resolveInstance(req)
      if (!inst) {
        res.status(200).send({ error: 'Instance not found' })
        return
      }
      registerUserAction(req, actionName)
      const result = await ProcessManager[opName](inst)
      RestartScheduler.clearPending(
        inst.protocolDriver,
        inst.protocolDriverInstanceNumber
      )
      res.status(200).send({ error: false, result })
    } catch (err) {
      Log.log(actionName + ' error: ' + err.message)
      res.status(200).send({ error: err.message || String(err) })
    }
  }
}

exports.startProtocolDriverInstance = actionHandler(
  'startProtocolDriverInstance',
  'start'
)
exports.stopProtocolDriverInstance = actionHandler(
  'stopProtocolDriverInstance',
  'stop'
)
exports.restartProtocolDriverInstance = actionHandler(
  'restartProtocolDriverInstance',
  'restart'
)

// Bulk status for the instances table (cached briefly to avoid hammering sc /
// supervisorctl when several browsers poll).
let statusCache = null
let statusCacheTime = 0
const STATUS_TTL_MS = 3000

exports.listDriverProcessStatus = async (req, res) => {
  try {
    if (statusCache && Date.now() - statusCacheTime < STATUS_TTL_MS) {
      res.status(200).send(statusCache)
      return
    }
    const instances = await ProtocolDriverInstance.find({}).lean().exec()
    const statuses = await ProcessManager.listStatuses(instances)
    const out = instances.map((inst, i) => {
      const st = statuses[i]
      return {
        protocolDriver: inst.protocolDriver,
        protocolDriverInstanceNumber: inst.protocolDriverInstanceNumber,
        serviceName: st.serviceName,
        manageable: st.manageable,
        reason: st.reason || '',
        installed: st.installed,
        state: st.state,
        startMode: st.startMode,
        node: st.node,
        restartPending: RestartScheduler.isPending(
          inst.protocolDriver,
          inst.protocolDriverInstanceNumber
        ),
      }
    })
    const payload = {
      enabled: ProcessManager.isEnabled(),
      localNode: ProcessManager.localNodeName(),
      statuses: out,
    }
    statusCache = payload
    statusCacheTime = Date.now()
    res.status(200).send(payload)
  } catch (err) {
    Log.log('listDriverProcessStatus error: ' + err.message)
    res.status(200).send({ error: err.message || String(err) })
  }
}

exports.syncDriverServices = async (req, res) => {
  Log.log('syncDriverServices')
  try {
    registerUserAction(req, 'syncDriverServices')
    const instances = await ProtocolDriverInstance.find({}).lean().exec()
    const result = await ProcessManager.reconcileAll(instances, {
      removeOrphans: req.body?.removeOrphans === true,
    })
    statusCache = null // force refresh
    res.status(200).send({ error: false, result })
  } catch (err) {
    Log.log('syncDriverServices error: ' + err.message)
    res.status(200).send({ error: err.message || String(err) })
  }
}

exports.getSystemSettings = async (req, res) => {
  try {
    const settings = await SystemSettings.getSettings()
    res.status(200).send({
      error: false,
      settings: {
        autoManageServices: settings.autoManageServices,
        autoRestartOnConnectionChange: settings.autoRestartOnConnectionChange,
      },
      processManagementEnabled: ProcessManager.isEnabled(),
      localNode: ProcessManager.localNodeName(),
    })
  } catch (err) {
    Log.log('getSystemSettings error: ' + err.message)
    res.status(200).send({ error: err.message || String(err) })
  }
}

exports.updateSystemSettings = async (req, res) => {
  try {
    registerUserAction(req, 'updateSystemSettings')
    const settings = await SystemSettings.updateSettings(req.body || {})
    res.status(200).send({ error: false, settings })
  } catch (err) {
    Log.log('updateSystemSettings error: ' + err.message)
    res.status(200).send({ error: err.message || String(err) })
  }
}
