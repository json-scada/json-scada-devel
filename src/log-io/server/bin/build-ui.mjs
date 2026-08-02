#!/usr/bin/env node
// Builds the UI package and copies its static assets into the server's lib/ui
// directory so the server can serve them. Cross-platform replacement for the
// former build-ui.sh (works on Windows, macOS and Linux).
import { execSync } from 'node:child_process'
import { cpSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const uiDir = resolve(here, '..', '..', 'ui')
const destDir = resolve(here, '..', 'lib', 'ui')

execSync('npm install', { cwd: uiDir, stdio: 'inherit' })
execSync('npm run build', { cwd: uiDir, stdio: 'inherit' })

mkdirSync(destDir, { recursive: true })
cpSync(resolve(uiDir, 'build'), destDir, { recursive: true })

// eslint-disable-next-line no-console
console.log(`Copied UI build assets to ${destDir}`)
