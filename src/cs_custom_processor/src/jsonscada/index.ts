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

// JSON-SCADA shared types and utilities
import { Double, ObjectId, MongoClient, Db } from 'mongodb'
export { Double, ObjectId, MongoClient, Db }
export * from './types.js'
export * from './logger.js'
export * from './load-config.js'
export * from './redundancy.js'
export * from './connection-manager.js'

export { default as Log } from './logger.js'
export { default as LoadConfig } from './load-config.js'
export { default as Redundancy } from './redundancy.js'

