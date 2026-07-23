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

// Cached accessor for the singleton global settings document. Used by the process
// management hooks to decide whether service actions run automatically.

'use strict'

const db = require('../models')
const SystemSetting = db.systemSetting

const DEFAULTS = {
  autoManageServices: true,
  autoRestartOnConnectionChange: true,
}

let cache = null
let cacheTime = 0
const TTL_MS = 5000

async function getSettings() {
  if (cache && Date.now() - cacheTime < TTL_MS) return cache
  try {
    const doc = await SystemSetting.findOne({ key: 'global' }).lean().exec()
    cache = { ...DEFAULTS, ...(doc || {}) }
  } catch (e) {
    cache = { ...DEFAULTS }
  }
  cacheTime = Date.now()
  return cache
}

async function updateSettings(patch) {
  const allowed = {}
  if (typeof patch.autoManageServices === 'boolean')
    allowed.autoManageServices = patch.autoManageServices
  if (typeof patch.autoRestartOnConnectionChange === 'boolean')
    allowed.autoRestartOnConnectionChange = patch.autoRestartOnConnectionChange
  const doc = await SystemSetting.findOneAndUpdate(
    { key: 'global' },
    { $set: allowed, $setOnInsert: { key: 'global' } },
    { upsert: true, new: true }
  )
    .lean()
    .exec()
  cache = { ...DEFAULTS, ...doc }
  cacheTime = Date.now()
  return cache
}

function invalidate() {
  cache = null
}

module.exports = { getSettings, updateSettings, invalidate, DEFAULTS }
