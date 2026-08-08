# DOX: src/demo_simul — Demo Data Simulator

## Purpose

Node.js service that generates simulated SCADA data for demonstration and testing purposes. Creates realistic tag values (analog, digital, counter) and injects them into MongoDB.

## Ownership

- demo_simul owns the demo data simulation

## Local Contracts

- **Language:** Node.js
- **Main entry:** `index.js`
- **Pattern:** standard Node.js app (`app-defs.js`, `load-config.js`, `simple-logger.js`)
- **Config:** INI file via Supervisor

## Work Guidance

- Generates realistic SCADA data patterns (sinusoidal analogs, periodic digitals, ramping counters)
- Used with `mongo_seed/realtime_data.json` for demo deployments
- Configurable data generation rate and value ranges

## Verification

- `npm install` — dependencies install cleanly
- Verify simulated data appears in MongoDB collections
