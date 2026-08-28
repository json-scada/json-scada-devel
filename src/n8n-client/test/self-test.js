/*
 * Self-test for the N8N driver helpers and HTTP paths.
 * Runs without MongoDB using in-memory mocks.
 *
 * Usage: node test/self-test.js   (from src/n8n-client)
 *
 * {json:scada} - Copyright (c) 2020-2024 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution.
 */

'use strict'

const assert = require('assert')
const http = require('http')
const path = require('path')

const F = require('../filters')
const T = require('../tags-creation')
const WebhookPusher = require('../webhook-push')
const { StartListener } = require('../http-listener')

let failures = 0
function ok(name, cond) {
  if (cond) console.log('  ok - ' + name)
  else {
    console.log('  FAIL - ' + name)
    failures++
  }
}

function testFilters() {
  console.log('filters:')
  const f = F.ParseFilters([
    'KAW2',
    'group2:TRAFO',
    'tag:X-1',
    'tagprefix:KAW',
    'soe:priority<=3',
    'soe:all',
  ])
  ok('parsed 4 value rules', f.valueRules.length === 4)
  ok('parsed 2 soe rules', f.soeRules.length === 2)
  ok('group1 match', F.MatchValue({ group1: 'KAW2', tag: 'z' }, f.valueRules))
  ok(
    'tagprefix match',
    F.MatchValue({ group1: 'zz', tag: 'KAWabc' }, f.valueRules)
  )
  ok('no match', !F.MatchValue({ group1: 'zz', tag: 'zz' }, f.valueRules))
  ok('soe priority match', F.MatchSoe({ priority: 2 }, f.soeRules))
  ok('mixed rules -> no server narrowing', F.BuildChangeStreamGroup1Match(f.valueRules) === null)
  ok(
    'pure group1 -> server narrowing',
    JSON.stringify(
      F.BuildChangeStreamGroup1Match([
        { kind: 'group1', value: 'A' },
        { kind: 'group1', value: 'B' },
      ])
    ) === '{"fullDocument.group1":{"$in":["A","B"]}}'
  )
  ok('empty topics matches all values', F.MatchValue({ tag: 'x' }, []))
  ok('empty soe forwards nothing', !F.MatchSoe({ priority: 1 }, []))
}

function testTags() {
  console.log('tags-creation:')
  ok('number -> analog', T.inferType(3.5) === 'analog')
  ok('boolean -> digital', T.inferType(true) === 'digital')
  ok('string -> string', T.inferType('hi') === 'string')
  ok('object -> json', T.inferType({ a: 1 }) === 'json')
  ok('numeric string -> analog', T.inferType('42') === 'analog')
  const tag = T.NewTag({ tag: 'N8N-X', value: 42.0 }, 3001, 300100001, 'N8N-MAIN')
  ok('NewTag analog', tag.type === 'analog')
  ok('NewTag value', Number(tag.value) === 42)
  ok('NewTag key', Number(tag._id) === 300100001)
  ok('NewTag origin supervised', tag.origin === 'supervised')
  ok('NewTag group1 from connection', tag.group1 === 'N8N-MAIN')
  const upd = T.SourceDataUpdate({ tag: 'N8N-X', value: true }, 3001)
  ok('SDU digital value', upd.valueAtSource === 1)
  ok('SDU originator', upd.originator === 'N8N|3001')
}

function testPusher() {
  return new Promise((resolve) => {
    console.log('webhook-push:')
    const received = []
    const srv = http.createServer((req, res) => {
      let b = ''
      req.on('data', (d) => (b += d))
      req.on('end', () => {
        received.push({ auth: req.headers['authorization'], body: JSON.parse(b) })
        res.writeHead(200)
        res.end('ok')
      })
    })
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      const p = new WebhookPusher(
        ['http://127.0.0.1:' + port + '/webhook/test'],
        { bearerToken: 'secret123', timeoutMs: 2000 }
      )
      ok('has targets', p.hasTargets())
      p.push({ schema: 'jsonscada-n8n/1', type: 'valueChange', points: [{ tag: 'A', value: 1 }] })
      p.push({ schema: 'jsonscada-n8n/1', type: 'heartbeat' })
      setTimeout(() => {
        ok('received both', received.length === 2)
        ok('bearer auth sent', received[0]?.auth === 'Bearer secret123')
        ok('valueChange first', received[0]?.body?.type === 'valueChange')
        ok('heartbeat second', received[1]?.body?.type === 'heartbeat')
        ok('stats sent==2', p.stats.sent === 2)
        p.stop()
        srv.close()
        resolve()
      }, 800)
    })
  })
}

function testListener() {
  return new Promise((resolve) => {
    console.log('http-listener:')
    const store = new Map()
    const rt = {
      find: (q) => ({
        limit: () => ({
          toArray: async () => {
            for (const [, v] of store)
              if (v.protocolSourceObjectAddress === q.protocolSourceObjectAddress)
                return [v]
            return []
          },
        }),
      }),
      insertOne: async (doc) => {
        store.set(doc.tag, doc)
        return { acknowledged: true }
      },
      updateOne: async (q, u) => {
        for (const [, v] of store)
          if (v.protocolSourceObjectAddress === q.protocolSourceObjectAddress) {
            v.sourceDataUpdate = u['$set'].sourceDataUpdate
            return { matchedCount: 1 }
          }
        return { matchedCount: 0 }
      },
      findOne: async () => null,
    }
    const stats = { inboundUpdates: 0, inboundCommands: 0 }
    let keySeq = 300100000
    const server = StartListener({
      configObj: {},
      connection: { protocolConnectionNumber: 3001, name: 'N8N-MAIN' },
      collections: { rt, cmd: null, userActions: null },
      isActive: () => true,
      allocKey: () => ++keySeq,
      listCreatedTags: new Set(),
      autoCreateTags: true,
      stats,
      bindAddress: '127.0.0.1',
      bindPort: 0,
      allowedIps: [],
      basicUser: 'n8n',
      basicPass: 'pw',
      enableDirectCommands: false,
      tls: null,
    })
    setTimeout(() => {
      const port = server.address().port
      const auth = 'Basic ' + Buffer.from('n8n:pw').toString('base64')
      const bad = 'Basic ' + Buffer.from('n8n:wrong').toString('base64')
      call(port, '/n8n/updates', 'POST', { points: [] }, null, (s1) => {
        call(port, '/n8n/updates', 'POST', { points: [] }, bad, (s2) => {
          call(
            port,
            '/n8n/updates',
            'POST',
            { points: [{ tag: 'N8N-CALC-1', value: 42.5 }] },
            auth,
            (s3) => {
              call(port, '/n8n/commands', 'POST', { tag: 'X', value: 1 }, auth, (s4) => {
                call(port, '/n8n/health', 'GET', null, null, (s5) => {
                  ok('no auth -> 401', s1 === 401)
                  ok('bad auth -> 401', s2 === 401)
                  ok('update -> 200', s3 === 200)
                  ok('tag auto-created', store.has('N8N-CALC-1'))
                  ok('sourceDataUpdate written', !!store.get('N8N-CALC-1')?.sourceDataUpdate)
                  ok('direct command disabled -> 403', s4 === 403)
                  ok('health public -> 200', s5 === 200)
                  server.close()
                  resolve()
                })
              })
            }
          )
        })
      })
    }, 300)
  })
}

function call(port, p, method, body, auth, cb) {
  const data = body ? JSON.stringify(body) : null
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: p,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(auth ? { Authorization: auth } : {}),
      },
    },
    (res) => {
      let b = ''
      res.on('data', (d) => (b += d))
      res.on('end', () => cb(res.statusCode, b))
    }
  )
  if (data) req.write(data)
  req.end()
}

;(async () => {
  testFilters()
  testTags()
  await testPusher()
  await testListener()
  console.log('')
  if (failures === 0) {
    console.log('ALL TESTS PASSED')
    process.exit(0)
  } else {
    console.log(failures + ' TEST(S) FAILED')
    process.exit(1)
  }
})()
