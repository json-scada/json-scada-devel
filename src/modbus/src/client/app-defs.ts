/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 * Licensed under the GNU General Public License v3. See LICENSE in the repo root.
 */

import type { AppDefs } from '../common/load-config.js'

const appDefs: AppDefs & { AUTOTAG_PREFIX: string } = {
  NAME: 'MODBUS',
  ENV_PREFIX: 'JS_MODBUS_',
  AUTOTAG_PREFIX: 'MODBUS',
  VERSION: '0.1.0',
  MSG: '{json:scada} - Modbus Client Driver',
}

export default appDefs
