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

// Latency instrumentation.
//
// Stage names, counter names, histogram bucketing and the JSON layout are
// identical to metrics.go in src/cs_data_processor-go, so a snapshot taken
// from either implementation can be compared field by field with
// cs_data_processor-go/tools/compare-latency.js.

'use strict'

const http = require('http')
const fs = require('fs')
const Log = require('./simple-logger')
const AppDefs = require('./app-defs')

// Latency stage identifiers. Keep in sync with metrics.go.
const Stage = {
  SourceToRecv: 'sourceToRecv', // driver timestamp -> change event delivered to this process
  QueueWait: 'queueWait', // delivered -> picked up for processing (always 0 in Node.js)
  Processing: 'processing', // handler start -> update decided and queued
  WriteLinger: 'writeLinger', // queued -> included in a flushed batch
  BulkWrite: 'bulkWrite', // duration of the realtimeData bulk write
  EndToEnd: 'endToEnd', // driver timestamp -> realtimeData write completed
  SoeWrite: 'soeWrite', // duration of the soeData insert
  HistWrite: 'histWrite', // duration of the hist insert + SQL file write
}

const stageOrder = [
  Stage.SourceToRecv,
  Stage.QueueWait,
  Stage.Processing,
  Stage.WriteLinger,
  Stage.BulkWrite,
  Stage.EndToEnd,
  Stage.SoeWrite,
  Stage.HistWrite,
]

// Counter names. Keep in sync with metrics.go.
const Counter = {
  ChangesReceived: 'changesReceived',
  ChangesProcessed: 'changesProcessed',
  Inserts: 'inserts',
  UpdatesQueued: 'updatesQueued',
  NotChanged: 'notChanged',
  IgnoredInactive: 'ignoredInactive',
  SoeInserted: 'soeInserted',
  HistQueued: 'histQueued',
  MongoBulkWrites: 'mongoBulkWrites',
  MongoDocsWritten: 'mongoDocsWritten',
  HistDocsWritten: 'histDocsWritten',
  SqlFilesWritten: 'sqlFilesWritten',
  Errors: 'errors',
  Dropped: 'droppedOnBackpressure',
  ChangeStreamRetries: 'changeStreamRetries',
}

const counterOrder = [
  Counter.ChangesReceived,
  Counter.ChangesProcessed,
  Counter.Inserts,
  Counter.UpdatesQueued,
  Counter.NotChanged,
  Counter.IgnoredInactive,
  Counter.SoeInserted,
  Counter.HistQueued,
  Counter.MongoBulkWrites,
  Counter.MongoDocsWritten,
  Counter.HistDocsWritten,
  Counter.SqlFilesWritten,
  Counter.Errors,
  Counter.Dropped,
  Counter.ChangeStreamRetries,
]

// ---------------------------------------------------------------------------
// Histogram: logarithmic buckets of microseconds, 64 sub buckets per octave.
// ---------------------------------------------------------------------------

const HIST_SUB_BUCKET_BITS = 6
const HIST_SUB_BUCKET_COUNT = 1 << HIST_SUB_BUCKET_BITS // 64
const HIST_BUCKET_COUNT = 4096

function histIndex(v) {
  if (v < HIST_SUB_BUCKET_COUNT) return v < 0 ? 0 : v
  // Math.clz32 gives the number of leading zero bits of a 32 bit integer;
  // above 2^31 the value is rescaled first so the bucketing stays valid.
  let shift = 0
  if (v < 0x80000000) {
    shift = 32 - Math.clz32(v) - (HIST_SUB_BUCKET_BITS + 1)
  } else {
    shift = Math.floor(Math.log2(v)) - HIST_SUB_BUCKET_BITS
  }
  const idx =
    HIST_SUB_BUCKET_COUNT * shift + Math.floor(v / Math.pow(2, shift))
  return idx >= HIST_BUCKET_COUNT ? HIST_BUCKET_COUNT - 1 : idx
}

function histValue(idx) {
  if (idx < 2 * HIST_SUB_BUCKET_COUNT) return idx
  const shift = Math.floor(idx / HIST_SUB_BUCKET_COUNT) - 1
  const sub = (idx % HIST_SUB_BUCKET_COUNT) + HIST_SUB_BUCKET_COUNT
  const width = Math.pow(2, shift)
  return sub * width + width / 2
}

class Histogram {
  constructor() {
    this.buckets = new Float64Array(HIST_BUCKET_COUNT)
    this.count = 0
    this.sum = 0
    this.min = Infinity
    this.max = 0
  }

  // observe records one sample given in microseconds
  observe(us) {
    if (!(us >= 0)) us = 0
    this.buckets[histIndex(us)]++
    this.count++
    this.sum += us
    if (us < this.min) this.min = us
    if (us > this.max) this.max = us
  }

  // observeMs records one sample given in (possibly fractional) milliseconds
  observeMs(ms) {
    this.observe(Math.round(ms * 1000))
  }

  observeSince(hrStart) {
    const d = process.hrtime.bigint() - hrStart
    this.observe(Number(d / 1000n))
  }

  reset() {
    this.buckets.fill(0)
    this.count = 0
    this.sum = 0
    this.min = Infinity
    this.max = 0
  }

  snapshot() {
    const st = {
      count: this.count,
      minMs: 0,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p99Ms: 0,
      p999Ms: 0,
    }
    if (this.count === 0) return st
    st.minMs = this.min / 1000
    st.maxMs = this.max / 1000
    st.avgMs = this.sum / this.count / 1000

    const targets = [
      [0.5, 'p50Ms'],
      [0.9, 'p90Ms'],
      [0.99, 'p99Ms'],
      [0.999, 'p999Ms'],
    ]
    let ti = 0
    let acc = 0
    for (let i = 0; i < HIST_BUCKET_COUNT && ti < targets.length; i++) {
      const c = this.buckets[i]
      if (c === 0) continue
      acc += c
      while (ti < targets.length && acc >= targets[ti][0] * this.count) {
        st[targets[ti][1]] = histValue(i) / 1000
        ti++
      }
    }
    for (; ti < targets.length; ti++) st[targets[ti][1]] = st.maxMs
    return st
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

class Metrics {
  constructor() {
    this.stages = {}
    this.counters = {}
    for (const s of stageOrder) this.stages[s] = new Histogram()
    for (const c of counterOrder) this.counters[c] = 0
    this.startedAt = Date.now()
    this.resetAt = Date.now()
    this.config = { Instance: 0, nodeName: '' }
    this.gaugeProvider = null
    this.isActive = () => false
  }

  stage(name) {
    let h = this.stages[name]
    if (!h) {
      h = new Histogram()
      this.stages[name] = h
    }
    return h
  }

  inc(name, delta = 1) {
    this.counters[name] = (this.counters[name] || 0) + delta
  }

  get(name) {
    return this.counters[name] || 0
  }

  setConfig(cfg) {
    this.config = cfg
  }

  setGaugeProvider(fn) {
    this.gaugeProvider = fn
  }

  setActiveProvider(fn) {
    this.isActive = fn
  }

  reset() {
    for (const k of Object.keys(this.stages)) this.stages[k].reset()
    for (const k of Object.keys(this.counters)) this.counters[k] = 0
    this.resetAt = Date.now()
  }

  snapshot() {
    let windowSec = (Date.now() - this.resetAt) / 1000
    if (windowSec <= 0) windowSec = 1e-9
    const counters = {}
    const ratesPerSec = {}
    for (const k of Object.keys(this.counters)) {
      counters[k] = this.counters[k]
      ratesPerSec[k] = this.counters[k] / windowSec
    }
    const latencyMs = {}
    for (const k of Object.keys(this.stages)) {
      latencyMs[k] = this.stages[k].snapshot()
    }
    let gauges = {}
    if (this.gaugeProvider) {
      try {
        gauges = this.gaugeProvider() || {}
      } catch (e) {
        gauges = {}
      }
    }
    return {
      implementation: AppDefs.IMPLEMENTATION,
      process: AppDefs.NAME,
      version: AppDefs.VERSION,
      instance: this.config.Instance || 0,
      nodeName: this.config.nodeName || '',
      processActive: !!this.isActive(),
      timestamp: new Date().toISOString(),
      uptimeSec: (Date.now() - this.startedAt) / 1000,
      windowSec: windowSec,
      counters: counters,
      ratesPerSec: ratesPerSec,
      gauges: gauges,
      latencyMs: latencyMs,
    }
  }
}

const M = new Metrics()

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function pad(s, n, left = true) {
  s = '' + s
  if (s.length >= n) return s
  const fill = ' '.repeat(n - s.length)
  return left ? fill + s : s + fill
}

function formatSummary(s) {
  const lines = []
  lines.push(
    `METRICS [${s.implementation}] instance ${s.instance} active=${
      s.processActive
    } uptime=${s.uptimeSec.toFixed(0)}s window=${s.windowSec.toFixed(0)}s`
  )
  let cnt = '  counters:'
  for (const k of counterOrder) {
    if (s.counters[k]) cnt += ` ${k}=${s.counters[k]}`
  }
  lines.push(cnt)
  lines.push(
    `  throughput: ${s.ratesPerSec[Counter.ChangesProcessed].toFixed(
      1
    )} changes/s, ${s.ratesPerSec[Counter.MongoDocsWritten].toFixed(
      1
    )} rt-docs/s`
  )
  const gk = Object.keys(s.gauges).sort()
  if (gk.length) {
    lines.push('  gauges:' + gk.map((k) => ` ${k}=${s.gauges[k]}`).join(''))
  }
  lines.push(
    '  ' +
      pad('stage(ms)', 14, false) +
      ['count', 'avg', 'p50', 'p90', 'p99', 'p99.9', 'max']
        .map((h) => ' ' + pad(h, 9))
        .join('')
  )
  for (const name of stageOrder) {
    const st = s.latencyMs[name]
    if (!st || st.count === 0) continue
    lines.push(
      '  ' +
        pad(name, 14, false) +
        ' ' +
        pad(st.count, 9) +
        [st.avgMs, st.p50Ms, st.p90Ms, st.p99Ms, st.p999Ms, st.maxMs]
          .map((v) => ' ' + pad(v.toFixed(3), 9))
          .join('')
    )
  }
  return lines.join('\n')
}

function formatPrometheus(s) {
  const out = []
  const lbl = `{impl="${s.implementation}",instance="${s.instance}",node="${s.nodeName}"}`
  out.push('# HELP csdp_uptime_seconds Process uptime.')
  out.push('# TYPE csdp_uptime_seconds gauge')
  out.push(`csdp_uptime_seconds${lbl} ${s.uptimeSec}`)
  out.push('# TYPE csdp_process_active gauge')
  out.push(`csdp_process_active${lbl} ${s.processActive ? 1 : 0}`)
  for (const k of Object.keys(s.counters).sort()) {
    out.push(`# TYPE csdp_${k}_total counter`)
    out.push(`csdp_${k}_total${lbl} ${s.counters[k]}`)
  }
  for (const k of Object.keys(s.gauges).sort()) {
    out.push(`# TYPE csdp_${k} gauge`)
    out.push(`csdp_${k}${lbl} ${s.gauges[k]}`)
  }
  for (const name of stageOrder) {
    const st = s.latencyMs[name]
    if (!st) continue
    const sl = `{impl="${s.implementation}",instance="${s.instance}",node="${s.nodeName}",stage="${name}"}`
    out.push(`csdp_latency_ms_count${sl} ${st.count}`)
    out.push(`csdp_latency_ms_avg${sl} ${st.avgMs}`)
    const qs = [
      ['0.5', st.p50Ms],
      ['0.9', st.p90Ms],
      ['0.99', st.p99Ms],
      ['0.999', st.p999Ms],
    ]
    for (const [q, v] of qs) {
      out.push(
        `csdp_latency_ms{impl="${s.implementation}",instance="${s.instance}",node="${s.nodeName}",stage="${name}",quantile="${q}"} ${v}`
      )
    }
    out.push(`csdp_latency_ms_max${sl} ${st.maxMs}`)
  }
  return out.join('\n') + '\n'
}

// statsDocument condenses the snapshot for the processInstances stats field.
function statsDocument() {
  const s = M.snapshot()
  const latencyMs = {}
  for (const name of stageOrder) {
    const st = s.latencyMs[name]
    if (!st || st.count === 0) continue
    latencyMs[name] = {
      count: st.count,
      avgMs: st.avgMs,
      p50Ms: st.p50Ms,
      p90Ms: st.p90Ms,
      p99Ms: st.p99Ms,
      maxMs: st.maxMs,
    }
  }
  const counters = {}
  for (const name of counterOrder) {
    if (s.counters[name]) counters[name] = s.counters[name]
  }
  return {
    implementation: s.implementation,
    uptimeSec: s.uptimeSec,
    windowSec: s.windowSec,
    changesPerSec: s.ratesPerSec[Counter.ChangesProcessed],
    counters: counters,
    latencyMs: latencyMs,
  }
}

function writeMetricsFile(path, snap) {
  try {
    fs.writeFileSync(path + '.tmp', JSON.stringify(snap, null, 2))
    fs.renameSync(path + '.tmp', path)
  } catch (e) {
    Log.log('Metrics - Error writing metrics file: ' + e)
  }
}

// startMetricsReporter starts the periodic log report, the optional metrics
// file dump and the optional HTTP endpoint.
function startMetricsReporter(jsConfig) {
  M.setConfig(jsConfig)

  const envPort = process.env[AppDefs.ENV_PREFIX + 'METRICS_PORT']
  const port = envPort ? parseInt(envPort) : 0
  const envInterval = process.env[AppDefs.ENV_PREFIX + 'METRICS_LOG_INTERVAL']
  const intervalSec = envInterval === undefined ? 60 : parseInt(envInterval)
  const metricsFile = process.env[AppDefs.ENV_PREFIX + 'METRICS_FILE'] || ''

  if (intervalSec > 0) {
    const h = setInterval(function () {
      const snap = M.snapshot()
      if (!snap.counters[Counter.ChangesReceived] && !snap.counters[Counter.ChangesProcessed])
        return
      Log.log(formatSummary(snap), Log.levelMin)
      if (metricsFile) writeMetricsFile(metricsFile, snap)
    }, intervalSec * 1000)
    if (h.unref) h.unref()
  }

  if (port > 0) {
    const server = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0]
      switch (url) {
        case '/metrics':
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(M.snapshot(), null, 2))
          break
        case '/metrics/prom':
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' })
          res.end(formatPrometheus(M.snapshot()))
          break
        case '/metrics/text':
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          res.end(formatSummary(M.snapshot()) + '\n')
          break
        case '/metrics/reset':
          M.reset()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"reset":true}')
          break
        case '/health':
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              ok: true,
              processActive: !!M.isActive(),
            })
          )
          break
        default:
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end('{"error":"not found"}')
      }
    })
    server.on('error', (e) => Log.log('Metrics - HTTP server error: ' + e))
    server.listen(port, () =>
      Log.log(
        'Metrics - HTTP endpoint on :' +
          port +
          ' (/metrics, /metrics/text, /metrics/prom, /metrics/reset)'
      )
    )
    server.unref()
  }
}

module.exports = {
  Stage,
  Counter,
  stageOrder,
  counterOrder,
  Histogram,
  M,
  formatSummary,
  formatPrometheus,
  statsDocument,
  startMetricsReporter,
}
