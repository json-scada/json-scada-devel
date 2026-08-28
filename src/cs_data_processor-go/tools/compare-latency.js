#!/usr/bin/env node
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

// Side by side latency report for the Node.js and Go implementations of
// CS_DATA_PROCESSOR. Both expose the same /metrics JSON document, so any
// combination of live endpoints and saved snapshots can be compared.
//
//   node compare-latency.js http://localhost:8081/metrics http://localhost:8082/metrics
//   node compare-latency.js nodejs.json go.json
//   node compare-latency.js --reset http://localhost:8081 http://localhost:8082
//
// With --reset the counters of every live endpoint are cleared and the tool
// waits --wait seconds (default 60) before collecting, which is the usual way
// to measure a defined window under an identical load.

'use strict'

const fs = require('fs')
const http = require('http')
const https = require('https')

const STAGES = [
  'sourceToRecv',
  'queueWait',
  'processing',
  'writeLinger',
  'bulkWrite',
  'endToEnd',
  'soeWrite',
  'histWrite',
]

const STAGE_HELP = {
  sourceToRecv: 'driver timestamp -> event delivered',
  queueWait: 'delivered -> picked up (0 in Node.js)',
  processing: 'conversion and decision',
  writeLinger: 'queued -> flushed in a batch',
  bulkWrite: 'realtimeData bulk write',
  endToEnd: 'driver timestamp -> written',
  soeWrite: 'soeData insert',
  histWrite: 'historian insert + SQL file',
}

const COUNTERS = [
  'changesReceived',
  'changesProcessed',
  'updatesQueued',
  'notChanged',
  'mongoBulkWrites',
  'mongoDocsWritten',
  'histDocsWritten',
  'soeInserted',
  'sqlFilesWritten',
  'droppedOnBackpressure',
  'errors',
]

function get(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http
    const req = mod.get(url, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(url + ' returned HTTP ' + res.statusCode))
          return
        }
        resolve(body)
      })
    })
    req.on('error', reject)
    req.setTimeout(10000, () => req.destroy(new Error('timeout on ' + url)))
  })
}

function metricsURL(target) {
  if (/\/metrics(\/|$)/.test(target)) return target
  return target.replace(/\/+$/, '') + '/metrics'
}

async function load(target) {
  if (/^https?:\/\//.test(target)) {
    return JSON.parse(await get(metricsURL(target)))
  }
  return JSON.parse(fs.readFileSync(target, 'utf8'))
}

function pad(s, n, left = true) {
  s = String(s)
  if (s.length >= n) return s
  const fill = ' '.repeat(n - s.length)
  return left ? fill + s : s + fill
}

function fmt(v) {
  if (v === undefined || v === null) return '-'
  if (v === 0) return '0'
  if (v < 10) return v.toFixed(3)
  if (v < 1000) return v.toFixed(1)
  return v.toFixed(0)
}

// ratio renders "how many times faster/slower" b is compared to a
function ratio(a, b) {
  if (!a || !b) return '-'
  const r = a / b
  if (r >= 1) return r.toFixed(2) + 'x faster'
  return (1 / r).toFixed(2) + 'x slower'
}

function label(snap, fallback) {
  if (!snap) return fallback
  return (snap.implementation || fallback) + '/i' + (snap.instance ?? '?')
}

function report(snaps) {
  const [a, b] = snaps
  const la = label(a, 'A')
  const lb = label(b, 'B')

  console.log('')
  console.log('CS_DATA_PROCESSOR latency comparison')
  console.log('='.repeat(96))
  for (const s of snaps) {
    console.log(
      `  ${pad(label(s), 14, false)} version ${pad(s.version, 12, false)} ` +
        `node ${pad(s.nodeName || '-', 14, false)} active=${s.processActive} ` +
        `window=${(s.windowSec || 0).toFixed(0)}s uptime=${(s.uptimeSec || 0).toFixed(0)}s`
    )
  }

  console.log('')
  console.log('Throughput and volume')
  console.log('-'.repeat(96))
  console.log(
    '  ' + pad('counter', 24, false) + pad(la, 16) + pad(lb, 16) + pad('B/A', 12)
  )
  for (const c of COUNTERS) {
    const va = a.counters?.[c] || 0
    const vb = b ? b.counters?.[c] || 0 : 0
    if (!va && !vb) continue
    const rel = va ? (vb / va).toFixed(2) + 'x' : '-'
    console.log('  ' + pad(c, 24, false) + pad(va, 16) + pad(vb, 16) + pad(rel, 12))
  }
  const ra = a.ratesPerSec?.changesProcessed || 0
  const rb = b ? b.ratesPerSec?.changesProcessed || 0 : 0
  console.log(
    '  ' +
      pad('changes/s', 24, false) +
      pad(ra.toFixed(1), 16) +
      pad(rb.toFixed(1), 16) +
      pad(ra ? (rb / ra).toFixed(2) + 'x' : '-', 12)
  )

  console.log('')
  console.log('Latency per stage, milliseconds')
  console.log('-'.repeat(96))
  console.log(
    '  ' +
      pad('stage', 14, false) +
      pad('impl', 10, false) +
      pad('count', 10) +
      pad('avg', 10) +
      pad('p50', 10) +
      pad('p90', 10) +
      pad('p99', 10) +
      pad('max', 10)
  )
  for (const st of STAGES) {
    const sa = a.latencyMs?.[st]
    const sb = b ? b.latencyMs?.[st] : null
    if ((!sa || !sa.count) && (!sb || !sb.count)) continue
    console.log('  ' + pad(st, 14, false) + '  ' + STAGE_HELP[st])
    for (const [lbl, s] of [
      [la, sa],
      [lb, sb],
    ]) {
      if (!s) continue
      console.log(
        '  ' +
          pad('', 14, false) +
          pad(lbl, 10, false) +
          pad(s.count, 10) +
          pad(fmt(s.avgMs), 10) +
          pad(fmt(s.p50Ms), 10) +
          pad(fmt(s.p90Ms), 10) +
          pad(fmt(s.p99Ms), 10) +
          pad(fmt(s.maxMs), 10)
      )
    }
  }

  if (b) {
    console.log('')
    console.log(`Verdict (${lb} relative to ${la})`)
    console.log('-'.repeat(96))
    for (const st of ['sourceToRecv', 'processing', 'writeLinger', 'endToEnd']) {
      const sa = a.latencyMs?.[st]
      const sb = b.latencyMs?.[st]
      if (!sa?.count || !sb?.count) continue
      console.log(
        '  ' +
          pad(st, 14, false) +
          ' p50 ' +
          pad(ratio(sa.p50Ms, sb.p50Ms), 16) +
          ' p99 ' +
          pad(ratio(sa.p99Ms, sb.p99Ms), 16) +
          ' avg ' +
          pad(ratio(sa.avgMs, sb.avgMs), 16)
      )
    }
  }
  console.log('')
}

async function main() {
  const argv = process.argv.slice(2)
  let doReset = false
  let waitSec = 60
  const targets = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--reset') doReset = true
    else if (argv[i] === '--wait') waitSec = parseInt(argv[++i])
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        'usage: compare-latency.js [--reset] [--wait seconds] <endpointOrFile> [endpointOrFile]'
      )
      process.exit(0)
    } else targets.push(argv[i])
  }
  if (targets.length === 0) {
    targets.push('http://localhost:8081', 'http://localhost:8082')
  }

  if (doReset) {
    for (const t of targets) {
      if (!/^https?:\/\//.test(t)) continue
      const base = t.replace(/\/metrics.*$/, '').replace(/\/+$/, '')
      await get(base + '/metrics/reset')
      console.log('reset ' + base)
    }
    console.log(`collecting for ${waitSec}s...`)
    await new Promise((r) => setTimeout(r, waitSec * 1000))
  }

  const snaps = []
  for (const t of targets) {
    try {
      snaps.push(await load(t))
    } catch (e) {
      console.error('error reading ' + t + ': ' + e.message)
      snaps.push(null)
    }
  }
  if (!snaps[0]) process.exit(1)
  report(snaps)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
