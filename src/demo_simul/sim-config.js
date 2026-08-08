/*
 * Tunables for the demo electrical simulation.
 * All options can be overridden by environment variables prefixed with
 * JS_DEMO_SIMUL_ (see AppDefs.ENV_PREFIX).
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

'use strict'

const AppDefs = require('./app-defs')

const DEFAULTS = {
  // simulation step / publishing
  STEP_PERIOD_MS: 2000, // physics step and publish period
  MODEL_REFRESH_MINUTES: 10, // reload point list from mongo (picks up new tags)
  FORCE_REFRESH_SECONDS: 300, // republish an unchanged point at least this often
  ANALOG_DEADBAND: 0.002, // fraction of the point base value

  // system-wide behavior
  NOMINAL_FREQUENCY: 60, // Hz (auto-detected per point, this is the fallback)
  LOAD_CYCLE_MINUTES: 60, // real minutes for one simulated 24 h load curve (0 = wall clock)
  LOAD_NOISE: 0.02, // per-bay stochastic load amplitude (p.u.)
  LOAD_TAU_SECONDS: 120, // per-bay load correlation time
  VOLTAGE_DROOP: 0.03, // p.u. voltage drop at full load
  VOLTAGE_NOISE: 0.004, // p.u. bus voltage noise
  VOLTAGE_TAU_SECONDS: 90,
  FREQUENCY_NOISE: 0.02, // Hz
  FREQUENCY_TAU_SECONDS: 45,
  PHASE_UNBALANCE: 0.015, // fraction, per-phase current unbalance
  AMBIENT_MEAN: 25, // degC, reference ambient for the thermal models
  AMBIENT_SWING: 6, // degC, peak-to-mean daily swing
  THERMAL_TAU_OIL_SECONDS: 1800,
  THERMAL_TAU_WINDING_SECONDS: 420,

  // tap changers
  ENABLE_TAP_AVR: true, // automatic voltage regulation when ATCC is INCLUDED
  TAP_STEP_PU: 0.00625, // voltage change per tap step
  TAP_DEADBAND_PU: 0.012, // AVR deadband
  TAP_DELAY_SECONDS: 25, // AVR time delay between operations

  // disturbances
  ENABLE_FAULTS: true,
  FAULT_RATE_PER_HOUR: 6, // expected short circuits per simulated hour
  PERMANENT_FAULT_PROBABILITY: 0.25,
  FAULT_CURRENT_FACTOR: 6, // multiple of rated current during the fault
  FAULT_VOLTAGE_DIP: 0.18, // p.u. bus voltage dip during the fault
  ENABLE_ALARMS: true,
  ALARM_RATE_PER_HOUR: 30, // nuisance/annunciation alarms per hour
  ALARM_MIN_SECONDS: 20,
  ALARM_MAX_SECONDS: 240,

  // topology coherence
  CLOSE_LOADED_BREAKERS: true, // on startup close breakers of bays with non-zero flow
  BREAKER_TRAVEL_MS: 300, // delay between command and status change
}

const BOOLEAN_KEYS = new Set(
  Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'boolean')
)

function parseBool(str) {
  return !/^(0|false|no|off)$/i.test(String(str).trim())
}

// read defaults overridden by JS_DEMO_SIMUL_* environment variables
function LoadSimConfig() {
  const cfg = {}
  for (const key of Object.keys(DEFAULTS)) {
    const envValue = process.env[AppDefs.ENV_PREFIX + key]
    if (envValue === undefined || envValue === '') {
      cfg[key] = DEFAULTS[key]
      continue
    }
    if (BOOLEAN_KEYS.has(key)) {
      cfg[key] = parseBool(envValue)
      continue
    }
    const num = parseFloat(envValue)
    cfg[key] = isNaN(num) ? DEFAULTS[key] : num
  }
  return cfg
}

module.exports = { LoadSimConfig, DEFAULTS }
