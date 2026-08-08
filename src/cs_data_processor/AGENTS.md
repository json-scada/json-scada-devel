# DOX: src/cs_data_processor — Change Stream Data Processor

## Purpose

Node.js service that processes MongoDB Change Stream events for alarm detection, event logging, and data transformation. The core event processing pipeline for SCADA data.

## Ownership

- cs_data_processor owns the change stream data processing pipeline

## Local Contracts

- **Language:** Node.js
- **Main entry:** `cs_data_processor.js`
- **Structure:**
  - `cs_data_processor.js` — main processing logic
  - `app-defs.js` — application definitions
  - `load-config.js` — configuration loader
  - `simple-logger.js` — logging utility
  - `redundancy.js` — high-availability support
- **Config:** INI file via Supervisor or environment variables

## Work Guidance

- Subscribes to MongoDB Change Streams on protocol data collections
- Detects alarm conditions based on configurable thresholds
- Logs events to the SOE (Sequence of Events) collection
- Can transform data format between protocol and storage schemas
- Designed for low-latency event processing

## Verification

- `npm install` — dependencies install cleanly
- Verify Change Stream processing with active protocol drivers producing data
- Check alarm detection with known test data
