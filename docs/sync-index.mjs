#!/usr/bin/env node
// Regenerates the repository-root index.md from README.md (the single authoritative
// body) and validates every Markdown link anchor in both files.
//
//   node docs/sync-index.mjs          write index.md, then validate
//   node docs/sync-index.mjs --check  only validate; exit 1 if index.md is stale
//                                     or any link/anchor is broken
//
// index.md differs from README.md only by a "generated" banner and by using
// repository-relative links instead of https://github.com/<repo>/blob/master/ links.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BLOB = 'https://github.com/riclolsen/json-scada/blob/master/'
const BANNER =
  '<!-- Generated from README.md by docs/sync-index.mjs. Edit README.md, then run: node docs/sync-index.mjs -->\n'
const checkOnly = process.argv.includes('--check')

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n')
const readme = read('README.md')
const expected = BANNER + readme.split(BLOB).join('')

let failures = 0
const fail = (msg) => {
  failures++
  console.error('ERROR: ' + msg)
}

if (checkOnly) {
  const current = fs.existsSync(path.join(root, 'index.md')) ? read('index.md') : ''
  if (current !== expected) fail('index.md is out of date; run: node docs/sync-index.mjs')
} else {
  fs.writeFileSync(path.join(root, 'index.md'), expected)
  console.log('index.md regenerated from README.md')
}

// GitHub heading slug (github-slugger rules): lowercase, drop punctuation except
// "-" and "_", spaces become "-", duplicates get -1, -2, ...
function slugsOf(markdown) {
  const seen = new Map()
  const slugs = new Set()
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    if (inFence) continue
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const text = m[2]
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/[`*]/g, '')
    let slug = text
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-')
    const n = seen.get(slug) ?? 0
    seen.set(slug, n + 1)
    if (n > 0) slug = `${slug}-${n}`
    slugs.add(slug)
  }
  return slugs
}

function checkLinks(file, markdown) {
  const dir = path.dirname(path.join(root, file))
  for (const m of markdown.matchAll(/\]\(([^)\s]+)(?:\s+'[^']*'|\s+"[^"]*")?\)/g)) {
    let target = m[1]
    if (target.startsWith(BLOB)) target = path.relative(dir, path.join(root, target.slice(BLOB.length))).split(path.sep).join('/')
    if (/^[a-z]+:/i.test(target)) continue // other external links are not validated
    const [p, anchor] = target.split('#')
    const resolved = p === '' ? path.join(root, file) : path.join(dir, decodeURIComponent(p))
    if (!fs.existsSync(resolved)) {
      fail(`${file}: link target not found: ${m[1]}`)
      continue
    }
    if (anchor && resolved.endsWith('.md') && !slugsOf(fs.readFileSync(resolved, 'utf8').replace(/\r\n/g, '\n')).has(anchor))
      fail(`${file}: anchor #${anchor} not found in ${path.relative(root, resolved)}`)
  }
}

checkLinks('README.md', readme)
checkLinks('index.md', checkOnly ? read('index.md') : expected)

if (failures) {
  console.error(`${failures} problem(s) found`)
  process.exit(1)
}
console.log('README.md / index.md: links and anchors OK')
