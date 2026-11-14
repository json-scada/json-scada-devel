const Log = require('./simple-logger')

// Queue of user actions (audit trail) waiting to be written to mongodb.
// It is bounded: while the database is unavailable the oldest entries are
// dropped beyond MAX_QUEUED (and the loss is logged once per episode).
const MAX_QUEUED = 100000

// Secrets never go to the audit trail: any field whose name looks like one
// (password, passphrase, privateKeyPassphrase, bindCredentials, secret, token,
// api key) is replaced, at any depth of plain objects and arrays.
const SECRET_KEY_RE = /passw|passphrase|secret|token|credential|api.?key/i
const REDACTED = '***'

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function redact(v, depth = 0) {
  if (depth > 20) return v
  if (Array.isArray(v)) return v.map((e) => redact(e, depth + 1))
  if (!isPlainObject(v)) return v // Date, ObjectId, Double... kept as they are
  const out = {}
  for (const [k, e] of Object.entries(v))
    out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redact(e, depth + 1)
  return out
}

// array with a moving head: O(1) enqueue/dequeue, batches without copying
// the whole queue; the consumed front part is dropped now and then
let items = []
let head = 0
let dropped = 0
const size = () => items.length - head

function compact() {
  if (head > 1024 && head * 2 > items.length) {
    items = items.slice(head)
    head = 0
  }
}

const UserActionsQueue = {
  enqueue(item) {
    if (size() >= MAX_QUEUED) {
      head++
      if (dropped++ === 0)
        Log.log('User actions queue full: oldest entries are being dropped!')
    }
    items.push(
      item && item.properties !== undefined
        ? { ...item, properties: redact(item.properties) }
        : item
    )
    compact()
  },
  peek: () => (size() > 0 ? items[head] : undefined),
  // up to n of the oldest entries, still queued
  peekMany: (n) => items.slice(head, head + Math.max(0, n)),
  dequeue() {
    const item = UserActionsQueue.dequeueMany(1)[0]
    return item
  },
  // removes the n oldest entries (after they were stored)
  dequeueMany(n) {
    const k = Math.min(Math.max(0, n), size())
    const out = items.slice(head, head + k)
    for (let i = head; i < head + k; i++) items[i] = undefined
    head += k
    if (size() === 0) {
      items = []
      head = 0
      if (dropped > 0) {
        Log.log('User actions queue drained, ' + dropped + ' entries were dropped')
        dropped = 0
      }
    } else compact()
    return out
  },
  isEmpty: () => size() === 0,
  size,
  redact,
}

module.exports = UserActionsQueue
