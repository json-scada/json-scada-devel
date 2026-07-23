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

// Simple leveled logger, matching the mqtt-sparkplug/simple-logger.js conventions
// (levels: 0=min, 1=normal, 2=detailed, 3=debug).
export const Log = {
  levelMin: 0,
  levelNormal: 1,
  levelDetailed: 2,
  levelDebug: 3,
  levelCurrent: 1,
  log(msg: string, level = 1): void {
    if (level <= this.levelCurrent) {
      console.log(new Date().toISOString() + ' - ' + msg)
    }
  },
}

export default Log
