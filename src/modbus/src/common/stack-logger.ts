/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

// Adapter between the protocol core's logging hooks and the shared JSON-SCADA
// logger. Level mapping:
//   debug -> 3 (logLevel=3 only: full frame traces)
//   info  -> 2 (detailed)
//   error -> 1 (normal: protocol/request errors are visible by default)

import Log from './simple-logger.js'
import type { StackLogger } from '../core/logging.js'

export function makeStackLogger(connectionName: string): StackLogger {
  const tag = connectionName + ': '
  return {
    // read dynamically: the log level can change while the driver is running
    get debugEnabled(): boolean {
      return Log.levelCurrent >= Log.levelDebug
    },
    debug(msg: string) {
      Log.log(tag + msg, Log.levelDebug)
    },
    info(msg: string) {
      Log.log(tag + msg, Log.levelDetailed)
    },
    error(msg: string) {
      Log.log(tag + msg, Log.levelNormal)
    },
  }
}
