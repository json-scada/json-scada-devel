# DOX: src/mongowr — MongoDB Writer

## Purpose

Node.js service that consumes MongoDB Change Streams and writes processed data to the real-time database. Acts as the persistence layer for protocol driver outputs.

## Ownership

- mongowr owns the MongoDB write path from Change Streams

## Local Contracts

- **Language:** Node.js
- **Main entry:** `index.js`
- **Structure:**
  - `index.js` — main application logic
  - `app-defs.js` — application definitions
  - `load-config.js` — configuration loader
  - `simple-logger.js` — logging utility
  - `redundancy.js` — high-availability support
  - `customized_module.js` — user-customizable processing module
- **Config:** INI file via Supervisor or environment variables

## Work Guidance

- Listens to MongoDB Change Streams on specific collections
- Processes and writes data to real-time data collections
- The `customized_module.js` allows users to inject custom processing logic
- Used in the data pipeline: Protocol Drivers → MongoDB Change Streams → mongowr → Real-time Data

## Verification

- `npm install` — dependencies install cleanly
- Verify Change Stream consumption with active protocol drivers
