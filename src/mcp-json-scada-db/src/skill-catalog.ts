/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  memorySkillFiles,
  SkillsExtension,
} from '@modelcontextprotocol/server/ext/skills'
import { srcDir } from './jsonscada/drivers.js'
import { loadDriverSkillFiles } from './driver-configuration-skills.js'
import { readSvgSkillFile } from './tools/skills.js'

// Publish only the shipped Agent Skill files. The installation may also hold
// local skills or working files in the same directories.
const SHIPPED_FILES = [
  'graphql-api-apps/SKILL.md',
  'protocol-driver-development/SKILL.md',
]

export async function loadSkillCatalog() {
  const root = path.resolve(srcDir(), '..', '.agents', 'skills')
  const files = await loadDriverSkillFiles()
  for (const relative of SHIPPED_FILES) {
    try {
      files[relative] = await readFile(path.join(root, relative))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Could not load MCP skill file ${relative}:`, error)
      }
    }
  }

  try {
    files['svg-scada/SKILL.md'] = (await readSvgSkillFile()).bytes
  } catch (error) {
    console.warn(`Could not load svg-scada for MCP discovery: ${(error as Error).message}`)
  }

  // One snapshot per process keeps manifests and served bytes in sync across
  // requests, including a stateless HTTP read following a skills/list.
  return SkillsExtension.load(memorySkillFiles(files))
}
