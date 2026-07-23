/*
 * {json:scada} - Copyright (c) 2020-2024 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * Outbound filter grammar for the N8N driver "topics" list.
 *
 * Value-change selectors (any match includes the point):
 *   group1:<name>        match realtimeData.group1 exactly
 *   group2:<name>        match realtimeData.group2 exactly
 *   tag:<name>           match realtimeData.tag exactly
 *   tagprefix:<prefix>   match realtimeData.tag starting with prefix
 *   <name>               shorthand for group1:<name>
 *
 * SOE (event) selectors, prefixed with "soe:":
 *   soe:all              include all SOE events
 *   soe:priority<=<n>    include SOE events with priority <= n
 *   soe:group1:<name>    include SOE events for a given group1
 *
 * An empty topics list means: all value changes for non-internal points
 * (pointKey > 0), and no SOE events (SOE must be explicitly opted in).
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

// parse the connection.topics array into structured value/soe rule sets
function ParseFilters(topics) {
  const valueRules = []
  const soeRules = []
  if (!Array.isArray(topics)) return { valueRules, soeRules }

  for (let raw of topics) {
    if (typeof raw !== 'string') continue
    const entry = raw.trim()
    if (entry === '') continue

    if (entry.toLowerCase().startsWith('soe:')) {
      const spec = entry.substring(4).trim()
      if (spec.toLowerCase() === 'all') {
        soeRules.push({ kind: 'all' })
      } else if (spec.toLowerCase().startsWith('priority<=')) {
        const n = parseInt(spec.substring('priority<='.length))
        if (!isNaN(n)) soeRules.push({ kind: 'priorityMax', value: n })
      } else if (spec.toLowerCase().startsWith('group1:')) {
        soeRules.push({ kind: 'group1', value: spec.substring(7) })
      }
      continue
    }

    const colon = entry.indexOf(':')
    if (colon === -1) {
      valueRules.push({ kind: 'group1', value: entry })
      continue
    }
    const key = entry.substring(0, colon).toLowerCase()
    const val = entry.substring(colon + 1)
    switch (key) {
      case 'group1':
        valueRules.push({ kind: 'group1', value: val })
        break
      case 'group2':
        valueRules.push({ kind: 'group2', value: val })
        break
      case 'tag':
        valueRules.push({ kind: 'tag', value: val })
        break
      case 'tagprefix':
        valueRules.push({ kind: 'tagprefix', value: val })
        break
      default:
        // unknown key, treat whole entry as group1 name
        valueRules.push({ kind: 'group1', value: entry })
    }
  }
  return { valueRules, soeRules }
}

// does a realtimeData document match the value rules?
// empty valueRules => match all (caller already restricts to pointKey > 0)
function MatchValue(point, valueRules) {
  if (!valueRules || valueRules.length === 0) return true
  for (const r of valueRules) {
    switch (r.kind) {
      case 'group1':
        if (point.group1 === r.value) return true
        break
      case 'group2':
        if (point.group2 === r.value) return true
        break
      case 'tag':
        if (point.tag === r.value) return true
        break
      case 'tagprefix':
        if (typeof point.tag === 'string' && point.tag.startsWith(r.value))
          return true
        break
    }
  }
  return false
}

// does a soeData document match the soe rules?
// empty soeRules => no SOE forwarding
function MatchSoe(event, soeRules) {
  if (!soeRules || soeRules.length === 0) return false
  for (const r of soeRules) {
    switch (r.kind) {
      case 'all':
        return true
      case 'priorityMax':
        if (typeof event.priority === 'number' && event.priority <= r.value)
          return true
        break
      case 'group1':
        if (event.group1 === r.value) return true
        break
    }
  }
  return false
}

// build a partial mongo $match narrowing for the change stream when all value
// rules are group1-based (server-side optimization). Returns null when a
// client-side filter is required (tag/tagprefix/group2 rules present).
function BuildChangeStreamGroup1Match(valueRules) {
  if (!valueRules || valueRules.length === 0) return null
  const group1s = []
  for (const r of valueRules) {
    if (r.kind !== 'group1') return null // mixed rules, filter client-side
    group1s.push(r.value)
  }
  if (group1s.length === 0) return null
  return { 'fullDocument.group1': { $in: group1s } }
}

module.exports = {
  ParseFilters,
  MatchValue,
  MatchSoe,
  BuildChangeStreamGroup1Match,
}
