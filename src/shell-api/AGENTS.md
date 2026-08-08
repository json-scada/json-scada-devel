# DOX: src/shell-api — Shell Command API

## Purpose

Node.js HTTP API that provides a secure bridge for executing shell commands from the JSON-SCADA web interface. Enables administrative operations through the web UI.

## Ownership

- shell-api owns the shell command execution API

## Local Contracts

- **Language:** Node.js
- **Main entry:** `shell-api.js` — single-file application
- **Config:** Environment variables or command-line arguments

## Work Guidance

- Provides authenticated HTTP endpoints for shell command execution
- Commands are restricted to a predefined allowlist for security
- Output is captured and returned as JSON

## Verification

- Test with allowed commands and verify output is returned correctly
- Test with disallowed commands and verify rejection
