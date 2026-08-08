# DOX: src/mongofw — MongoDB Firewall / Forwarder

## Purpose

One-way data replication firewall/forwarder for air-gapped environments. Provides secure real-time data replication across network boundaries (e.g., via data diode or tap device).

## Ownership

- mongofw owns the one-way replication infrastructure

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
- **Diagrams:** `jsonscada-onewayrepl.drawio`, `jsonscada-onewayrepl.svg`
- **Config:** INI file via Supervisor or environment variables

## Work Guidance

- Designed for unidirectional data flow (source → destination)
- Supports point database sync and historical data backfill
- Operates over Ethernet data diode or tap device for physical isolation
- Both source and destination are MongoDB instances
- Configurable collection filtering and field mapping

## Verification

- `npm install` — dependencies install cleanly
- Test with source and destination MongoDB instances
- Verify no data flows in reverse direction
