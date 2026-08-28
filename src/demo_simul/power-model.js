/*
 * Electrical process model for the {json:scada} demo database.
 *
 * The model discovers the substation topology directly from the realtimeData
 * collection (tag naming convention SSSSMMMMMPPPP... plus group1/group2), then
 * simulates a physically coherent power system instead of jittering every point
 * independently:
 *
 *   - a system-wide daily load curve, frequency and ambient temperature;
 *   - per-bus voltages in per-unit, with load droop and tap-changer influence;
 *   - per-bay active/reactive power driven by a stochastic load process;
 *   - currents derived from S and V (I = 1000/sqrt(3) * S / V), not randomized;
 *   - apparent power derived from P and Q;
 *   - transformer winding/oil temperatures from a first-order thermal model;
 *   - breaker/switch positions that actually zero the flows of their bay;
 *   - short circuits with protection pickup/trip, auto-reclosing and fault
 *     location, plus annunciation alarms that reset by themselves.
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

const Log = require('./simple-logger')

// 1000/sqrt(3): S[MVA] and V[kV] -> I[A], same constant used by the calculations driver
const K_CURRENT = 577.35027

// ---------------------------------------------------------------- math utils

function gauss() {
  let u = 0
  let v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

function clamp(x, lo, hi) {
  return (
    x < lo ? lo
    : x > hi ? hi
    : x
  )
}

// Ornstein-Uhlenbeck step around zero: keeps the stationary std. dev. at sigma
// regardless of the step size, so the process looks the same at any period.
function ouStep(prev, tau, sigma, dt) {
  const a = Math.exp(-dt / Math.max(tau, 1e-3))
  return prev * a + sigma * Math.sqrt(Math.max(1 - a * a, 0)) * gauss()
}

// first order lag towards a target
function lag(prev, target, tau, dt) {
  const a = Math.exp(-dt / Math.max(tau, 1e-3))
  return target + (prev - target) * a
}

function isFiniteNumber(x) {
  return typeof x === 'number' && isFinite(x)
}

function numberOf(x, dflt = 0) {
  if (isFiniteNumber(x)) return x
  const n = parseFloat(x)
  return isFinite(n) ? n : dflt
}

// ------------------------------------------------------- tag / doc parsing

// Tags follow the convention: 4 chars station, 5 chars module (bay), then the
// point code whose first 4 chars are the IEC 61850-like logical node.
function parseTag(tag) {
  const t = String(tag || '')
  if (t.length >= 10)
    return {
      station: t.substr(0, 4),
      module: t.substr(4, 5),
      code: t.substr(9),
      quantity: t.substr(9, 4),
    }
  return { station: t.substr(0, 4), module: '', code: '', quantity: '' }
}

const QUANTITY_BY_CODE = {
  MTWT: 'P',
  ZTWT: 'P',
  MTVR: 'Q',
  ZTVR: 'Q',
  MTVA: 'S',
  ZTVA: 'S',
  MAPH: 'I',
  ZAPH: 'I',
  MVPP: 'V',
  MVPH: 'V',
  ZVPP: 'V',
  MFHZ: 'F',
  YTAP: 'TAP',
  YIMT: 'TOIL',
  YHPT: 'TWDG',
  ZTMP: 'TAMB',
  ZVAC: 'VAC',
  ZVDC: 'VDC',
  RFLO: 'FLOC',
}

const QUANTITY_BY_UNIT = {
  mw: 'P',
  kw: 'P',
  w: 'P',
  mvar: 'Q',
  kvar: 'Q',
  mva: 'S',
  kva: 'S',
  a: 'I',
  ka: 'I',
  kv: 'V',
  v: 'V',
  hz: 'F',
  pos: 'TAP',
  vca: 'VAC',
  vcc: 'VDC',
  km: 'FLOC',
  oc: 'TGEN',
  '°c': 'TGEN',
}

function analogQuantity(doc, parsed) {
  const byCode = QUANTITY_BY_CODE[parsed.quantity]
  if (byCode) return byCode
  return QUANTITY_BY_UNIT[String(doc.unit || '').toLowerCase()] || ''
}

// phase suffix of a measurement point (A/B/C), '' when not phase-segregated
function phaseOf(code) {
  const m = String(code).match(/-([ABC])$/)
  return m ? m[1] : ''
}

function parseKv(text) {
  const m = String(text || '').match(/([0-9]+(?:[.,][0-9]+)?)\s*kv/i)
  if (!m) return 0
  return parseFloat(m[1].replace(',', '.'))
}

// quantities whose zero default means "not in service", so they must stay at zero
const ZERO_STAYS_ZERO = new Set([
  'F',
  'TOIL',
  'TWDG',
  'TAMB',
  'TGEN',
  'VAC',
  'VDC',
])

const RE_TRANSFORMER = /^(TR|AT|RT)[0-9]/
const RE_TRUE_CLOSED = /^(ON|CLOSED|FECHADO|LIGADO|FECHADA)$/i
const RE_ABNORMAL =
  /(ALARM|DEFECT|FAIL|FALHA|OPERAT|OPERAD|BLOQ|BLOCK|LOCKED|LOCAL|DESCARR|ATUAD)/i
const RE_STARTED = /(start|partida|\bpart\b|pickup)/i
const RE_OPERATED = /(oper|opr\b|trip)/i
const RE_EXCLUDE_PROT =
  /(fail|falh|bloq|block|blck|incl|excl|remote|local|superv|comun|communic|sinc|sync|ajust|hiaj|lwaj|lodc|loac)/i
const RE_PROTECTION =
  /^(PDIS|PTOC|PIOC|PDEF|PTOV|PDIF|RBRF|PSOF|PSTI|PTTR|PTUV)/

function bayKindOf(module, group2) {
  const g = String(group2 || '')
  if (RE_TRANSFORMER.test(module)) return 'transformer'
  if (/^BC|^CP/.test(module) || /cap|banco/i.test(g)) return 'capacitor'
  if (/serv\.?\s*aux|aux\b/i.test(g)) return 'auxiliary'
  if (/substat|p[aá]tio/i.test(g)) return 'ambient'
  if (/^(barra|bus|bar\b)/i.test(g)) return 'busbar'
  if (/^(TL|LT|LN)\s*[0-9]/i.test(g)) return 'line'
  if (/^(FD|AL|SD)\s*[0-9]/i.test(g) || /^AL/.test(module)) return 'feeder'
  if (/ger|gen\b/i.test(g)) return 'generator'
  if (/^IB/.test(module) || /interlig|tie/i.test(g)) return 'tie'
  return 'other'
}

// ------------------------------------------------------------------- model

class PowerModel {
  constructor(cfg) {
    this.cfg = cfg
    this.simTime = 0 // seconds since model start
    this.timers = [] // scheduled callbacks {at, fn}
    this.points = new Map() // _id -> point
    this.pointsByTag = new Map()
    this.bays = new Map()
    this.buses = new Map()
    this.elements = new Map() // transformer element -> tap/temperature owner
    this.alarmPool = []
    this.faultCandidates = []
    this.built = false

    // system state
    this.freqDev = 0
    this.loadWalk = 0
    this.ambientNoise = 0
    this.startedAt = Date.now()
  }

  // -------------------------------------------------------------- topology

  build(docs) {
    this.points.clear()
    this.pointsByTag.clear()
    this.bays.clear()
    this.buses.clear()
    this.elements.clear()
    this.alarmPool = []
    this.faultCandidates = []

    const previous = this.pointStateBackup || new Map()

    for (const doc of docs) {
      if (doc.origin !== 'supervised') continue
      if (doc.type !== 'analog' && doc.type !== 'digital') continue
      const parsed = parseTag(doc.tag)
      const bay = this.getBay(doc, parsed)
      const point = {
        _id: doc._id,
        tag: doc.tag,
        type: doc.type,
        code: parsed.code,
        quantity: doc.type === 'analog' ? analogQuantity(doc, parsed) : '',
        phase: phaseOf(parsed.code),
        unit: doc.unit || '',
        base: numberOf(doc.valueDefault, numberOf(doc.value, 0)),
        value: numberOf(doc.value, numberOf(doc.valueDefault, 0)),
        published: NaN,
        publishedAt: 0,
        bay: bay,
        role: '',
        stateTrueIsAbnormal: false,
        unbalance: 0,
      }
      // keep simulated state across model refreshes
      const prev = previous.get(String(doc._id))
      if (prev !== undefined) point.value = prev

      if (doc.type === 'digital') this.classifyDigital(point, doc, parsed)
      else this.classifyAnalog(point, bay)

      this.points.set(String(doc._id), point)
      this.pointsByTag.set(doc.tag, point)
      bay.points.push(point)
    }

    this.finishBays()
    this.built = true

    Log.log(
      'Model - ' +
        this.points.size +
        ' points, ' +
        this.bays.size +
        ' bays, ' +
        this.buses.size +
        ' buses, ' +
        this.elements.size +
        ' transformers, ' +
        this.faultCandidates.length +
        ' faultable bays'
    )
  }

  getBay(doc, parsed) {
    const station = doc.group1 || parsed.station || '?'
    const group2 = doc.group2 || parsed.module || ''
    const key = station + '~' + group2
    let bay = this.bays.get(key)
    if (bay) return bay

    const kv = parseKv(group2) || parseKv(doc.description)
    bay = {
      key: key,
      station: station,
      group2: group2,
      module: parsed.module,
      kind: bayKindOf(parsed.module, group2),
      kv: kv,
      bus: null,
      element: null,
      points: [],
      breakers: [],
      switches: [],
      protStart: [],
      protOper: [],
      recloser: { inclusion: null, start: [], success: [], oper: [] },
      pPoints: [],
      qPoints: [],
      sPoints: [],
      iPoints: [],
      vPoints: [],
      faultLocPoints: [],
      pBase: 0,
      qBase: 0,
      sBase: 0,
      loadFactor: 1,
      pfDrift: 0,
      energized: true,
      energyRamp: 1,
      fault: null,
      lockedOut: false,
    }
    this.bays.set(key, bay)

    if (kv > 0) {
      const busKey = station + '|' + kv
      let bus = this.buses.get(busKey)
      if (!bus) {
        bus = {
          key: busKey,
          station: station,
          kv: kv,
          pu: 1, // effective per-unit voltage (steady state minus dip)
          puSteady: 1,
          noise: 0,
          tapBoost: 0,
          tapAccum: 0,
          tapCount: 0,
          dip: 0,
          loading: 0,
          bays: [],
        }
        this.buses.set(busKey, bus)
      }
      bus.bays.push(bay)
      bay.bus = bus
    }

    if (RE_TRANSFORMER.test(parsed.module)) {
      const elKey = parsed.station + parsed.module.substr(0, 3)
      let el = this.elements.get(elKey)
      if (!el) {
        el = {
          key: elKey,
          bays: [],
          tapPoints: [],
          autoPoints: [],
          hvBus: null,
          lvBus: null,
          loadFactor: 1,
          lastTapAt: -1e9,
        }
        this.elements.set(elKey, el)
      }
      el.bays.push(bay)
      bay.element = el
    }

    return bay
  }

  classifyAnalog(point, bay) {
    switch (point.quantity) {
      case 'P':
        bay.pPoints.push(point)
        break
      case 'Q':
        bay.qPoints.push(point)
        break
      case 'S':
        bay.sPoints.push(point)
        break
      case 'I':
        bay.iPoints.push(point)
        break
      case 'V':
        bay.vPoints.push(point)
        break
      case 'FLOC':
        bay.faultLocPoints.push(point)
        break
      case 'TAP':
        point.tapBase = Math.round(point.base)
        point.tap = Math.round(point.value)
        point.tapMin = Math.min(1, point.tapBase)
        point.tapMax = Math.max(17, point.tapBase + 8)
        if (bay.element) bay.element.tapPoints.push(point)
        break
      default:
        break
    }
  }

  classifyDigital(point, doc, parsed) {
    const bay = point.bay
    const trueText = String(doc.stateTextTrue || '')
    const desc = String(doc.ungroupedDescription || doc.description || '')
    const q = parsed.quantity

    if (q === 'XCBR' && RE_TRUE_CLOSED.test(trueText)) {
      point.role = 'breaker'
      bay.breakers.push(point)
      return
    }
    if (q === 'XSWI' && /^(CLOSED|FECHADO|FECHADA)$/i.test(trueText)) {
      point.role = 'switch'
      bay.switches.push(point)
      return
    }
    if (q === 'RREC') {
      if (/inclus/i.test(desc)) {
        point.role = 'reclInclusion'
        bay.recloser.inclusion = point
        return
      }
      if (RE_STARTED.test(desc)) {
        point.role = 'reclStart'
        bay.recloser.start.push(point)
        return
      }
      if (/sucess|success|opok/i.test(desc + point.code)) {
        point.role = 'reclSuccess'
        bay.recloser.success.push(point)
        return
      }
      if (RE_OPERATED.test(desc) && !RE_EXCLUDE_PROT.test(desc)) {
        point.role = 'reclOper'
        bay.recloser.oper.push(point)
        return
      }
    }
    if (RE_PROTECTION.test(q) && !RE_EXCLUDE_PROT.test(desc)) {
      if (RE_STARTED.test(desc)) {
        point.role = 'protStart'
        bay.protStart.push(point)
        return
      }
      if (RE_OPERATED.test(desc)) {
        point.role = 'protOper'
        bay.protOper.push(point)
        return
      }
    }
    if (RE_ABNORMAL.test(trueText)) {
      point.role = 'alarm'
      point.stateTrueIsAbnormal = true
      this.alarmPool.push(point)
      return
    }
    point.role = 'other'
  }

  finishBays() {
    for (const bay of this.bays.values()) {
      bay.pBase = bay.pPoints.reduce((a, p) => a + p.base, 0)
      bay.qBase = bay.qPoints.reduce((a, p) => a + p.base, 0)
      bay.sBase = Math.hypot(bay.pBase, bay.qBase)
      if (bay.sBase === 0 && bay.sPoints.length)
        bay.sBase = Math.abs(bay.sPoints[0].base)

      // a bay without its own voltage measurement borrows the bus nominal
      bay.kvBase =
        bay.kv || (bay.vPoints.length ? Math.abs(bay.vPoints[0].base) : 0)

      // calibrate currents so that at the database default operating point the
      // physical formula reproduces the stored default value
      for (const ip of bay.iPoints) {
        ip.ical = 0
        if (bay.sBase > 0 && bay.kvBase > 0 && ip.base > 0) {
          const computed = (K_CURRENT * bay.sBase) / bay.kvBase
          const k = ip.base / computed
          if (k > 0.3 && k < 3) ip.ical = k
        }
        ip.unbalance = ouStep(0, 1, this.cfg.PHASE_UNBALANCE, 1)
      }

      // fault candidates: bays that carry load and can be switched off
      if (
        (bay.kind === 'feeder' || bay.kind === 'line') &&
        bay.breakers.length > 0 &&
        Math.abs(bay.pBase) > 0.01
      )
        this.faultCandidates.push(bay)

      bay.energized = this.bayIsEnergized(bay)
      bay.energyRamp = bay.energized ? 1 : 0
    }

    for (const el of this.elements.values()) {
      const withBus = el.bays.filter((b) => b.bus)
      if (withBus.length) {
        withBus.sort((a, b) => a.bus.kv - b.bus.kv)
        el.lvBus = withBus[0].bus
        el.hvBus = withBus[withBus.length - 1].bus
      }
      // two-winding transformer with both sides metered: the outgoing winding
      // is derived from the incoming one so that losses have the right sign
      const metered = el.bays.filter((b) => Math.abs(b.pBase) > 0.01)
      if (
        metered.length === 2 &&
        Math.sign(metered[0].pBase) !== Math.sign(metered[1].pBase)
      )
        el.balance = {
          from: metered[0].pBase > 0 ? metered[0] : metered[1],
          to: metered[0].pBase > 0 ? metered[1] : metered[0],
        }

      // ATCC "INCLUDED" point enables automatic voltage regulation
      for (const bay of el.bays)
        for (const p of bay.points)
          if (
            p.type === 'digital' &&
            p.code.substr(0, 4) === 'ATCC' &&
            p.code.length <= 5
          )
            el.autoPoints.push(p)
    }
  }

  bayIsEnergized(bay) {
    if (bay.lockedOut) return false
    if (bay.breakers.length === 0) return true
    return bay.breakers.some((b) => b.value >= 0.5)
  }

  // Bring the seeded demo database back to a coherent starting state: a bay
  // that carries power must have its breaker closed, and protection/reclosing
  // signals must be at rest while no fault is in progress.
  coherenceFixes() {
    let breakersClosed = 0
    let signalsReset = 0
    for (const bay of this.bays.values()) {
      if (this.cfg.CLOSE_LOADED_BREAKERS)
        if (Math.abs(bay.pBase) >= 0.01 || Math.abs(bay.qBase) >= 0.01)
          for (const brk of bay.breakers)
            if (brk.value < 0.5) {
              brk.value = 1
              breakersClosed++
            }

      const atRest = [
        ...bay.protStart,
        ...bay.protOper,
        ...bay.recloser.start,
        ...bay.recloser.success,
        ...bay.recloser.oper,
      ]
      for (const p of atRest)
        if (p.value >= 0.5) {
          p.value = 0
          signalsReset++
        }

      bay.energized = this.bayIsEnergized(bay)
      bay.energyRamp = bay.energized ? 1 : 0
    }
    Log.log(
      'Model - coherence: closed ' +
        breakersClosed +
        ' breakers of loaded bays, reset ' +
        signalsReset +
        ' protection signals'
    )
    return breakersClosed + signalsReset
  }

  // save simulated values so a model rebuild does not restart from the defaults
  snapshot() {
    const m = new Map()
    for (const [id, p] of this.points) m.set(id, p.value)
    this.pointStateBackup = m
  }

  // ------------------------------------------------------------ scheduling

  schedule(delaySeconds, fn) {
    this.timers.push({ at: this.simTime + delaySeconds, fn: fn })
  }

  runTimers() {
    if (!this.timers.length) return
    const due = this.timers.filter((t) => t.at <= this.simTime)
    if (!due.length) return
    this.timers = this.timers.filter((t) => t.at > this.simTime)
    for (const t of due) {
      try {
        t.fn()
      } catch (e) {
        Log.log('Model - timer error: ' + e.message)
      }
    }
  }

  // -------------------------------------------------------- system drivers

  hourOfDay() {
    const cycle = this.cfg.LOAD_CYCLE_MINUTES
    if (cycle > 0) return ((this.simTime / (cycle * 60)) * 24) % 24
    const d = new Date()
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600
  }

  // normalized daily load shape, mean 1.0, night valley ~0.79, evening peak ~1.22
  dailyLoad(hour) {
    const w = (2 * Math.PI) / 24
    return (
      1 +
      0.155 * Math.cos(w * (hour - 19)) +
      0.055 * Math.cos(2 * w * (hour - 13)) +
      0.025 * Math.cos(3 * w * (hour - 10))
    )
  }

  ambientTemperature(hour) {
    const w = (2 * Math.PI) / 24
    return (
      this.cfg.AMBIENT_MEAN +
      this.cfg.AMBIENT_SWING * Math.cos(w * (hour - 15)) +
      this.ambientNoise
    )
  }

  // ------------------------------------------------------------------ step

  step(dt) {
    if (!this.built) return
    this.simTime += dt
    this.runTimers()

    const hour = this.hourOfDay()
    const previousLoad = this.systemLoad || 1
    this.loadWalk = ouStep(this.loadWalk, 900, 0.015, dt)
    this.systemLoad = this.dailyLoad(hour) * (1 + this.loadWalk)
    this.ambientNoise = ouStep(this.ambientNoise, 600, 0.8, dt)
    this.ambient = this.ambientTemperature(hour)

    // frequency: noise plus a transient proportional to the load ramp
    const dLoad = (this.systemLoad - previousLoad) / Math.max(dt, 1e-3)
    this.freqDev = clamp(
      ouStep(
        this.freqDev,
        this.cfg.FREQUENCY_TAU_SECONDS,
        this.cfg.FREQUENCY_NOISE,
        dt
      ) -
        3 * dLoad,
      -0.25,
      0.25
    )

    this.stepBays(dt)
    if (this.cfg.ENABLE_TAP_AVR) this.stepTapChangers(dt)
    this.refreshTapBoosts()
    this.stepBuses(dt)
    this.stepAnalogs(dt)
    if (this.cfg.ENABLE_FAULTS) this.maybeStartFault(dt)
    if (this.cfg.ENABLE_ALARMS) this.maybeRaiseAlarm(dt)
  }

  stepBays(dt) {
    for (const bay of this.bays.values()) {
      bay.energized = this.bayIsEnergized(bay)
      // cold load pickup: flows come back progressively after re-energization
      bay.energyRamp = bay.energized ? lag(bay.energyRamp, 1, 8, dt) : 0

      const noise = this.cfg.LOAD_NOISE
      const tau = this.cfg.LOAD_TAU_SECONDS
      bay.walk = ouStep(bay.walk || 0, tau, noise, dt)
      bay.pfDrift = ouStep(bay.pfDrift, tau * 2, 0.05, dt)
      bay.loadFactor = this.systemLoad * (1 + bay.walk)
    }

    // both windings of a transformer must move together
    for (const el of this.elements.values()) {
      let f = 0
      let n = 0
      for (const bay of el.bays)
        if (Math.abs(bay.pBase) > 0) {
          f += bay.loadFactor
          n++
        }
      el.loadFactor = n ? f / n : this.systemLoad
      for (const bay of el.bays) bay.loadFactor = el.loadFactor
    }
  }

  stepBuses(dt) {
    for (const bus of this.buses.values()) {
      // aggregated loading of the bus relative to its own default
      let s = 0
      let sBase = 0
      for (const bay of bus.bays) {
        if (bay.kind === 'busbar') continue
        s += Math.abs(bay.sBase) * bay.loadFactor * bay.energyRamp
        sBase += Math.abs(bay.sBase)
      }
      bus.loading = sBase > 0 ? s / sBase : this.systemLoad

      bus.noise = ouStep(
        bus.noise,
        this.cfg.VOLTAGE_TAU_SECONDS,
        this.cfg.VOLTAGE_NOISE,
        dt
      )
      const target =
        1 -
        this.cfg.VOLTAGE_DROOP * (bus.loading - 1) * 0.5 -
        this.cfg.VOLTAGE_DROOP * 0.5 * (this.systemLoad - 1) +
        bus.tapBoost +
        bus.noise
      // the steady state is the state variable, the fault dip only rides on top
      // of it so that repeated dips cannot accumulate
      bus.puSteady = lag(bus.puSteady, target, 20, dt)
      bus.dip = lag(bus.dip, 0, 1.5, dt)
      if (bus.dip < 1e-4) bus.dip = 0
      bus.pu = clamp(bus.puSteady - bus.dip, 0.5, 1.15)
    }
  }

  stepAnalogs(dt) {
    for (const bay of this.bays.values()) this.stepBayPower(bay)
    this.balanceTransformers()
    for (const bay of this.bays.values()) this.stepBayDerived(bay, dt)
  }

  // active and reactive power injected in the bay
  stepBayPower(bay) {
    const active = bay.energyRamp
    let p = 0
    let q = 0
    for (const pp of bay.pPoints) {
      pp.value = pp.base * bay.loadFactor * active
      p += pp.value
    }
    for (const qp of bay.qPoints) {
      if (bay.kind === 'capacitor') {
        // capacitor output follows the square of the applied voltage
        const pu = bay.bus ? bay.bus.pu : 1
        qp.value = qp.base * pu * pu * active
      } else {
        qp.value = qp.base * bay.loadFactor * (1 + bay.pfDrift) * active
      }
      q += qp.value
    }
    if (bay.pPoints.length === 0 && bay.qPoints.length === 0) {
      p = bay.pBase * bay.loadFactor * active
      q = bay.qBase * bay.loadFactor * active
    }
    bay.p = p
    bay.q = q
  }

  // A transformer cannot deliver more than it takes: the outgoing winding gets
  // the incoming power minus no-load and load losses. The seeded demo defaults
  // do not respect that, so the outgoing side is rescaled here.
  balanceTransformers() {
    for (const el of this.elements.values()) {
      const bal = el.balance
      if (!bal) continue
      const pIn = bal.from.p
      const pOut = bal.to.p
      if (pIn === 0 || pOut === 0) continue
      const loading = clamp(Math.abs(el.loadFactor), 0, 2)
      const lossFraction = 0.001 + 0.005 * loading * loading
      const target = -Math.sign(pIn) * Math.abs(pIn) * (1 - lossFraction)
      const scale = target / pOut
      if (!isFiniteNumber(scale) || scale <= 0) continue
      for (const pp of bal.to.pPoints) pp.value *= scale
      bal.to.p = target
    }
  }

  // quantities derived from the bay power flow, plus the standalone ones
  stepBayDerived(bay, dt) {
    const kv = this.bayVoltage(bay)
    const active = bay.energyRamp
    const faulted = bay.fault && bay.fault.stage === 'fault'
    const s = Math.hypot(bay.p, bay.q)
    bay.s = s

    // apparent power measured at the bay (calculated points are the
    // calculations driver's job, these are the supervised ones)
    for (const sp of bay.sPoints)
      sp.value = s || sp.base * bay.loadFactor * active

    // currents from S and V, with a small per-phase unbalance
    for (const ip of bay.iPoints) {
      ip.unbalance = ouStep(ip.unbalance, 300, this.cfg.PHASE_UNBALANCE, dt)
      let value
      if (ip.ical > 0 && kv > 0) value = (ip.ical * K_CURRENT * s) / kv
      else value = ip.base * bay.loadFactor * active
      value *= 1 + ip.unbalance
      if (faulted) value *= this.cfg.FAULT_CURRENT_FACTOR
      ip.value = value
    }

    // voltages
    for (const vp of bay.vPoints) {
      if (vp.base === 0) {
        vp.value = 0
        continue
      }
      const pu = bay.bus ? bay.bus.pu : 1
      vp.value = vp.base * pu
    }

    // everything else that is not bound to the bay power flow
    for (const point of bay.points) {
      if (point.type !== 'analog') continue
      // a default of zero means the measurement is not in service
      if (point.base === 0 && ZERO_STAYS_ZERO.has(point.quantity)) {
        point.value = 0
        continue
      }
      switch (point.quantity) {
        case 'F': {
          if (point.base === 0) {
            point.value = 0
            break
          }
          const fNom =
            point.base > 55 ? 60
            : point.base > 45 ? 50
            : Math.round(point.base)
          const bias = clamp(point.base - fNom, -0.05, 0.05)
          point.value = fNom + bias + this.freqDev
          break
        }
        case 'TOIL':
        case 'TWDG': {
          const tau =
            point.quantity === 'TOIL' ?
              this.cfg.THERMAL_TAU_OIL_SECONDS
            : this.cfg.THERMAL_TAU_WINDING_SECONDS
          const span = Math.max(Math.abs(point.base) * 0.18, 6)
          const loading = clamp(bay.loadFactor * active, 0, 2)
          const target =
            bay.energized ?
              point.base +
              span * (loading * loading - 1) +
              (this.ambient - this.cfg.AMBIENT_MEAN)
            : point.base - span
          point.value = clamp(
            lag(point.value, target, tau, dt),
            Math.max(0, point.base - span),
            point.base + 2 * span
          )
          break
        }
        case 'TAMB':
          point.value =
            point.base + (this.ambient - this.cfg.AMBIENT_MEAN) + 0.05 * gauss()
          break
        case 'TGEN':
          point.value = lag(
            point.value,
            point.base + (this.ambient - this.cfg.AMBIENT_MEAN),
            300,
            dt
          )
          break
        case 'VAC': {
          const pu = this.stationPu(bay.station)
          point.value = point.base * pu * (1 + 0.001 * gauss())
          break
        }
        case 'VDC':
          point.value = clamp(
            lag(point.value, point.base, 600, dt) + 0.05 * gauss(),
            point.base * 0.9,
            point.base * 1.05
          )
          break
        case 'TAP':
          point.value = point.tap
          break
        case 'FLOC':
          // holds the last fault location, only written by a fault event
          break
        default:
          break
      }
    }
  }

  bayVoltage(bay) {
    if (bay.bus) return bay.bus.kv * bay.bus.pu
    if (bay.kvBase) return bay.kvBase
    return 0
  }

  stationPu(station) {
    let sum = 0
    let n = 0
    for (const bus of this.buses.values())
      if (bus.station === station) {
        sum += bus.pu
        n++
      }
    return n ? sum / n : 1
  }

  // ------------------------------------------------------- tap changers

  stepTapChangers(dt) {
    for (const el of this.elements.values()) {
      if (!el.tapPoints.length || !el.lvBus) continue
      const auto =
        el.autoPoints.length ? el.autoPoints.some((p) => p.value >= 0.5) : false
      const tapPoint = el.tapPoints[0]
      if (!auto) continue
      if (this.simTime - el.lastTapAt < this.cfg.TAP_DELAY_SECONDS) continue
      const err = el.lvBus.pu - 1
      if (Math.abs(err) <= this.cfg.TAP_DEADBAND_PU) continue
      const dir = err < 0 ? 1 : -1
      const next = clamp(tapPoint.tap + dir, tapPoint.tapMin, tapPoint.tapMax)
      if (next === tapPoint.tap) continue
      tapPoint.tap = next
      tapPoint.value = next
      el.lastTapAt = this.simTime
      Log.log(
        'Model - AVR ' +
          el.key +
          ' tap ' +
          next +
          ' (bus pu ' +
          el.lvBus.pu.toFixed(3) +
          ')',
        2
      )
    }
  }

  // A bus can be fed by several transformers: its voltage follows the average
  // of their tap positions, so one changer alone cannot overwrite the others.
  refreshTapBoosts() {
    for (const bus of this.buses.values()) {
      bus.tapAccum = 0
      bus.tapCount = 0
    }
    for (const el of this.elements.values()) {
      if (!el.lvBus || !el.tapPoints.length) continue
      const tp = el.tapPoints[0]
      el.lvBus.tapAccum += (tp.tap - tp.tapBase) * this.cfg.TAP_STEP_PU
      el.lvBus.tapCount++
    }
    for (const bus of this.buses.values())
      bus.tapBoost = bus.tapCount ? bus.tapAccum / bus.tapCount : 0
  }

  // ------------------------------------------------------------- switching

  setBreaker(point, closed, reason) {
    point.value = closed ? 1 : 0
    const bay = point.bay
    bay.energized = this.bayIsEnergized(bay)
    if (!bay.energized) bay.energyRamp = 0
    Log.log(
      'Model - ' +
        point.tag +
        ' -> ' +
        (closed ? 'CLOSED' : 'OPEN') +
        ' (' +
        reason +
        ')',
      2
    )
  }

  // ------------------------------------------------------------- faults

  maybeStartFault(dt) {
    if (!this.faultCandidates.length) return
    const rate = this.cfg.FAULT_RATE_PER_HOUR / 3600
    if (Math.random() > rate * dt) return
    const pool = this.faultCandidates.filter(
      (b) => !b.fault && b.energized && !b.lockedOut
    )
    if (!pool.length) return
    this.startFault(pool[Math.floor(Math.random() * pool.length)])
  }

  startFault(bay) {
    const permanent = Math.random() < this.cfg.PERMANENT_FAULT_PROBABILITY
    bay.fault = { stage: 'fault', permanent: permanent }
    Log.log(
      'Model - short circuit on ' +
        bay.key +
        (permanent ? ' (permanent)' : ' (transient)')
    )

    // protection pickup, fault current and voltage dip
    for (const p of bay.protStart) p.value = 1
    if (bay.bus) bay.bus.dip = this.cfg.FAULT_VOLTAGE_DIP

    // distance to fault, when the bay publishes a fault locator
    for (const fl of bay.faultLocPoints) {
      const span = Math.abs(fl.base) > 0 ? Math.abs(fl.base) : 40
      fl.value = Math.round(span * (0.05 + 0.9 * Math.random()) * 100) / 100
    }

    this.schedule(1.2, () => this.faultTrip(bay))
  }

  faultTrip(bay) {
    if (!bay.fault) return
    bay.fault.stage = 'tripped'
    for (const p of bay.protOper) p.value = 1
    for (const brk of bay.breakers)
      this.setBreaker(brk, false, 'protection trip')

    const canReclose =
      bay.recloser.inclusion !== null && bay.recloser.inclusion.value >= 0.5
    if (canReclose) {
      this.schedule(2.5, () => {
        for (const p of bay.recloser.start) p.value = 1
      })
      this.schedule(5, () => this.faultReclose(bay))
    } else {
      this.schedule(6, () => this.faultReset(bay, false))
      this.scheduleRestoration(bay)
    }
  }

  faultReclose(bay) {
    if (!bay.fault) return
    for (const brk of bay.breakers) this.setBreaker(brk, true, 'auto-reclose')
    if (bay.fault.permanent) {
      // reclosing onto the fault: trip again and lock out
      this.schedule(1.5, () => {
        for (const brk of bay.breakers)
          this.setBreaker(brk, false, 'reclose onto fault')
        bay.lockedOut = true
        for (const p of bay.recloser.oper) p.value = 1
        this.schedule(5, () => this.faultReset(bay, false))
        this.scheduleRestoration(bay)
      })
      return
    }
    for (const p of bay.recloser.success) p.value = 1
    for (const p of bay.recloser.oper) p.value = 1
    this.schedule(6, () => this.faultReset(bay, true))
  }

  faultReset(bay, restored) {
    for (const p of bay.protStart) p.value = 0
    for (const p of bay.protOper) p.value = 0
    for (const p of bay.recloser.start) p.value = 0
    for (const p of bay.recloser.success) p.value = 0
    for (const p of bay.recloser.oper) p.value = 0
    if (restored) bay.fault = null
  }

  // operator/field restoration of a locked out bay after a while
  scheduleRestoration(bay) {
    const delay = 90 + Math.random() * 210
    this.schedule(delay, () => {
      bay.lockedOut = false
      bay.fault = null
      for (const brk of bay.breakers) this.setBreaker(brk, true, 'restoration')
      Log.log('Model - ' + bay.key + ' restored after lockout')
    })
  }

  // -------------------------------------------------------------- alarms

  maybeRaiseAlarm(dt) {
    if (!this.alarmPool.length) return
    const rate = this.cfg.ALARM_RATE_PER_HOUR / 3600
    if (Math.random() > rate * dt) return
    const point =
      this.alarmPool[Math.floor(Math.random() * this.alarmPool.length)]
    if (point.alarmPending) return
    const original = point.value >= 0.5 ? 1 : 0
    point.value = original ? 0 : 1
    point.alarmPending = true
    const duration =
      this.cfg.ALARM_MIN_SECONDS +
      Math.random() * (this.cfg.ALARM_MAX_SECONDS - this.cfg.ALARM_MIN_SECONDS)
    this.schedule(duration, () => {
      point.value = original
      point.alarmPending = false
    })
  }

  // ------------------------------------------------------------ commands

  // Returns true when the model owns the supervised point of a command.
  applyCommand(supervisedId, value) {
    const point = this.points.get(String(supervisedId))
    if (!point) return false

    if (point.type === 'digital') {
      const closed = value >= 0.5
      if (point.role === 'breaker') {
        const bay = point.bay
        this.schedule(this.cfg.BREAKER_TRAVEL_MS / 1000, () => {
          if (closed) {
            bay.lockedOut = false
            bay.fault = null
          }
          this.setBreaker(point, closed, 'operator command')
        })
        return true
      }
      point.value = closed ? 1 : 0
      return true
    }

    if (point.quantity === 'TAP') {
      // 1 = raise, 0 = lower
      const dir = value >= 0.5 ? 1 : -1
      point.tap = clamp(point.tap + dir, point.tapMin, point.tapMax)
      point.value = point.tap
      const el = point.bay.element
      if (el) el.lastTapAt = this.simTime
      this.refreshTapBoosts()
      return true
    }

    point.value = value
    return true
  }

  // ------------------------------------------------------------- output

  // list of points whose value moved enough (or went stale) to be published
  collectUpdates(nowMs) {
    const out = []
    const forceMs = this.cfg.FORCE_REFRESH_SECONDS * 1000
    for (const point of this.points.values()) {
      if (!isFiniteNumber(point.value)) continue
      let value = point.value
      if (point.type === 'digital' || point.quantity === 'TAP')
        value = Math.round(value)

      const stale = nowMs - point.publishedAt > forceMs
      if (!stale && isFiniteNumber(point.published)) {
        if (point.type === 'digital' || point.quantity === 'TAP') {
          if (value === point.published) continue
        } else {
          const deadband = Math.max(
            Math.abs(point.base) * this.cfg.ANALOG_DEADBAND,
            1e-4
          )
          if (Math.abs(value - point.published) < deadband) continue
        }
      }

      const changed = point.published !== value
      point.published = value
      point.publishedAt = nowMs
      out.push({
        _id: point._id,
        tag: point.tag,
        value: value,
        isDigital: point.type === 'digital',
        isTap: point.quantity === 'TAP',
        changed: changed,
      })
    }
    return out
  }

  // human readable snapshot for the log
  summary() {
    const hour = this.hourOfDay()
    return (
      'sim ' +
      String(Math.floor(hour)).padStart(2, '0') +
      ':' +
      String(Math.floor((hour % 1) * 60)).padStart(2, '0') +
      ' load ' +
      this.systemLoad.toFixed(3) +
      ' pu, f ' +
      (60 + this.freqDev).toFixed(3) +
      ' Hz, ambient ' +
      this.ambient.toFixed(1) +
      ' C, faults active ' +
      [...this.bays.values()].filter((b) => b.fault).length
    )
  }
}

module.exports = { PowerModel, parseTag, parseKv, K_CURRENT }
