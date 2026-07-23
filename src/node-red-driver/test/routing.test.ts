/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Unit tests for value routing and timestamp normalization (no MongoDB required).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { routeValue, toDate } from '../src/tags.ts'

test('routeValue infers analog from number', () => {
  const r = routeValue(42.5)
  assert.equal(r.type, 'analog')
  assert.equal(r.valueAtSource, 42.5)
  assert.equal(r.valueStringAtSource, '42.5')
})

test('routeValue infers digital from boolean', () => {
  const rTrue = routeValue(true)
  assert.equal(rTrue.type, 'digital')
  assert.equal(rTrue.valueAtSource, 1)
  assert.equal(rTrue.valueStringAtSource, 'true')
  const rFalse = routeValue(false)
  assert.equal(rFalse.valueAtSource, 0)
  assert.equal(rFalse.valueStringAtSource, 'false')
})

test('routeValue infers string and still extracts leading number', () => {
  const r = routeValue('12abc')
  assert.equal(r.type, 'string')
  assert.equal(r.valueStringAtSource, '12abc')
  assert.equal(r.valueAtSource, 12)
})

test('routeValue infers json from object and keeps parsed payload', () => {
  const obj = { a: 1, b: [2, 3] }
  const r = routeValue(obj)
  assert.equal(r.type, 'json')
  assert.deepEqual(r.valueJsonAtSource, obj)
})

test('routeValue respects declared pointType over inference', () => {
  const r = routeValue('1', 'digital')
  assert.equal(r.type, 'digital')
  assert.equal(r.valueAtSource, 1)
})

test('routeValue json pointType parses a JSON string', () => {
  const r = routeValue('{"x":5}', 'json')
  assert.equal(r.type, 'json')
  assert.deepEqual(r.valueJsonAtSource, { x: 5 })
})

test('routeValue handles non-finite analog gracefully', () => {
  const r = routeValue('not-a-number', 'analog')
  assert.equal(r.type, 'analog')
  assert.equal(r.valueAtSource, 0)
})

test('toDate treats small numbers as epoch seconds', () => {
  const d = toDate(1_600_000_000) // seconds
  assert.equal(d.getUTCFullYear(), 2020)
})

test('toDate treats large numbers as epoch millis', () => {
  const d = toDate(1_600_000_000_000) // ms
  assert.equal(d.getUTCFullYear(), 2020)
})

test('toDate parses ISO strings and falls back on garbage', () => {
  const good = toDate('2026-07-04T00:00:00.000Z')
  assert.equal(good.getUTCFullYear(), 2026)
  const bad = toDate('nonsense')
  assert.ok(bad instanceof Date && !Number.isNaN(bad.getTime()))
})
