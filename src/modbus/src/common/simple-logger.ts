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

// Simple leveled console logger, ported from the mqtt-sparkplug driver so that
// all JSON-SCADA drivers share the same log format and level semantics.
export const LogLevel = {
  min: 0,
  normal: 1,
  detailed: 2,
  debug: 3,
} as const

class SimpleLogger {
  levelMin = LogLevel.min
  levelNormal = LogLevel.normal
  levelDetailed = LogLevel.detailed
  levelDebug = LogLevel.debug
  levelCurrent: number = LogLevel.normal

  log(msg: unknown, level = 1): void {
    if (level <= this.levelCurrent) {
      console.log(new Date().toISOString() + ' - ' + String(msg))
    }
  }

  logError(msg: unknown, level = 0): void {
    if (level <= this.levelCurrent) {
      console.error(new Date().toISOString() + ' - ' + String(msg))
    }
  }
}

const Log = new SimpleLogger()
export default Log
