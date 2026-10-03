#!/usr/bin/env node
// Checks relative Markdown links and #anchors in every tracked *.md file.
//
//   node docs/check-links.mjs [path-prefix ...]
//
// Sources are the working-tree content of tracked *.md files. Targets must exist in the
// COMMITTED tree (git ls-tree HEAD): untracked, gitignored or local-only files do not
// count. Links into submodules are listed but not verified; external URLs other than
// this repo's github.com/riclolsen/json-scada blob/tree links are skipped.
// Exit code 1 when a link target or anchor is missing.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const git = (c) => execSync('git ' + c, { cwd: root, maxBuffer: 1 << 28 }).toString()
const tree = git('ls-tree -r -t HEAD').split('\n').filter(Boolean).map((l) => {
  const [meta, p] = l.split('\t')
  return { type: meta.split(' ')[1], p }
})
const paths = new Set(tree.map((e) => e.p))
const submodules = tree.filter((e) => e.type === 'commit').map((e) => e.p)
const REPO = /^https:\/\/github\.com\/riclolsen\/json-scada\/(?:blob|tree)\/master\//

function slugs(md) {
  const seen = new Map(), out = new Set()
  let fence = false
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const text = m[2].replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/[`*]/g, '').replace(/(^|[^\p{L}\p{N}_])_([^_]+)_(?=[^\p{L}\p{N}_]|$)/gu, '$1$2')
    let s = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-')
    const n = seen.get(s) ?? 0
    seen.set(s, n + 1)
    out.add(n ? `${s}-${n}` : s)
  }
  // explicit <a name|id="..."> anchors
  for (const m of md.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/g)) out.add(m[1])
  return out
}

// Known, accepted exceptions: third-party text that is not edited here.
const ALLOW = new Set([
  'src/opcdaaehda-client-solution-net/LICENSE.md#licenses/Source_Code_License_Agreement.pdf', // vendored upstream license text
])
const exclude = (f) => f.startsWith('src/svgedit/') || f.includes('node_modules/') || f.startsWith('platform-windows/grafana-runtime/')
const files = git('ls-files "*.md"').split('\n').filter(Boolean).filter((f) => !exclude(f))
const only = process.argv.slice(2)
let problems = 0
for (const f of files) {
  if (only.length && !only.some((o) => f.startsWith(o))) continue
  const abs = path.join(root, f)
  if (!fs.existsSync(abs)) continue
  const md = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
  const lines = md.split('\n')
  let fence = false
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) return
    const stripped = line.replace(/`[^`]*`/g, '')
    for (const m of stripped.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g)) {
      let t = m[1]
      if (REPO.test(t)) t = path.posix.relative(path.posix.dirname(f), t.replace(REPO, '')) || '.'
      else if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('//')) continue
      const [p, anchor] = t.split('#')
      let target = p === '' ? f : path.posix.normalize(path.posix.join(path.posix.dirname(f), decodeURI(p)))
      target = target.replace(/\/$/, '')
      const where = `${f}:${i + 1}`
      if (ALLOW.has(`${f}#${m[1]}`)) continue
      const sub = submodules.find((s) => target === s || target.startsWith(s + '/'))
      if (sub && target !== sub) { console.log(`${where}\tsubmodule-content\t${m[1]}`); continue }
      if (!paths.has(target) && target !== '.') { problems++; console.log(`${where}\tmissing-target\t${m[1]}`); continue }
      if (anchor && target.endsWith('.md')) {
        const content = fs.existsSync(path.join(root, target)) ? fs.readFileSync(path.join(root, target), 'utf8').replace(/\r\n/g, '\n') : git(`show HEAD:"${target}"`).replace(/\r\n/g, '\n')
        if (!slugs(content).has(decodeURIComponent(anchor))) { problems++; console.log(`${where}\tmissing-anchor\t${m[1]}`) }
      }
    }
  })
}
console.log(`problems: ${problems}`)
if (problems) process.exit(1)
