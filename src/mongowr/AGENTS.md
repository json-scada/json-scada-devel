# DOX: src/mongowr — MongoDB Writer

## Purpose

One-way data replication receiver for air-gapped environments. Receives secure real-time data replication across network boundaries (e.g., via data diode or tap device).

## Ownership

- mongowr owns the MongoDB write path from received data packets.

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
