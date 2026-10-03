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

// Client for the AdminUI backend API (server_realtime_auth, /Invoke/auth/*).
// Configuration changes and OS service (process) management go through this API
// instead of writing MongoDB directly, so they get the same validation,
// protocol defaults, auto-restart scheduling, NSSM/supervisord service control
// and userActions audit trail as changes made in the AdminUI.

import Log from './logger.js'
import packageInfo from '../../package.json' with { type: 'json' }

const ENV_PREFIX = packageInfo.config.envPrefix || 'JS_MCPJSDB_'
const API_PATH = '/Invoke/auth/'

export class AdminApiClient {
  readonly baseUrl: string
  private readonly username: string
  private readonly password: string
  private token: string | null = null

  constructor() {
    this.baseUrl = (
      process.env[ENV_PREFIX + 'ADMIN_URL'] || 'http://127.0.0.1:8080'
    ).replace(/\/+$/, '')
    this.username = process.env[ENV_PREFIX + 'ADMIN_USERNAME'] || ''
    this.password = process.env[ENV_PREFIX + 'ADMIN_PASSWORD'] || ''
  }

  // Admin tools are only offered when admin credentials are configured
  get enabled(): boolean {
    return this.username !== '' && this.password !== ''
  }

  get user(): string {
    return this.username
  }

  private async signin(): Promise<string> {
    const res = await fetch(this.baseUrl + API_PATH + 'signin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: this.username,
        password: this.password,
      }),
    })
    const body: any = await res.json().catch(() => ({}))
    if (!res.ok || body?.ok !== true)
      throw new Error(
        `Admin API sign-in failed for user '${this.username}': ${
          body?.message || res.status + ' ' + res.statusText
        }`
      )
    // the access token is only returned as an http-only cookie
    for (const cookie of res.headers.getSetCookie()) {
      const m = /^x-access-token=([^;]+)/.exec(cookie)
      if (m && m[1]) return decodeURIComponent(m[1])
    }
    throw new Error('Admin API sign-in returned no access token.')
  }

  private static isAuthFailure(status: number, body: any): boolean {
    if (status === 401 || status === 403) return true
    return (
      body?.ok === false &&
      typeof body?.message === 'string' &&
      body.message.startsWith('Access not allowed')
    )
  }

  // POSTs to an /Invoke/auth/<endpoint> route and returns the parsed JSON body.
  // Signs in lazily and once more when the token is rejected (expired).
  // Throws when the API reports an error ({ error: ... }).
  async call(endpoint: string, body: any = {}): Promise<any> {
    if (!this.enabled)
      throw new Error(
        `Admin API not configured. Set ${ENV_PREFIX}ADMIN_USERNAME and ${ENV_PREFIX}ADMIN_PASSWORD.`
      )
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.token) this.token = await this.signin()
      let res: Response
      try {
        res = await fetch(this.baseUrl + API_PATH + endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-access-token': this.token,
          },
          body: JSON.stringify(body),
        })
      } catch (e) {
        throw new Error(
          `Admin API unreachable at ${this.baseUrl} (is server_realtime_auth running?): ${
            e instanceof Error ? e.message : String(e)
          }`
        )
      }
      const data: any = await res.json().catch(() => ({}))
      if (AdminApiClient.isAuthFailure(res.status, data)) {
        this.token = null
        if (attempt === 0) continue
        throw new Error(
          `Admin API denied access for user '${this.username}': ${
            data?.message || res.status
          } (the user needs a role with isAdmin rights)`
        )
      }
      if (!res.ok)
        throw new Error(`Admin API ${endpoint}: HTTP ${res.status}`)
      if (data && typeof data === 'object' && data.error)
        throw new Error(
          `Admin API ${endpoint}: ${
            typeof data.error === 'string'
              ? data.error
              : data.error.message || JSON.stringify(data.error)
          }`
        )
      Log.log(`Admin API ${endpoint} OK`, Log.levelDetailed)
      return data
    }
  }
}
