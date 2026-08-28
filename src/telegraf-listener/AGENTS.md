# DOX: src/telegraf-listener — Telegraf Listener

## Purpose

Node.js HTTP listener that receives data from Telegraf outputs and writes it to MongoDB. Acts as the bridge between Telegraf data collection and the JSON-SCADA real-time database.

## Ownership

- telegraf-listener owns the Telegraf data ingestion endpoint

## Local Contracts

- **Language:** Node.js
- **Main entry:** `index.js` — simple single-file application
- **Config:** INI file via Supervisor or environment variables

## Work Guidance

- Listens for HTTP POST requests from Telegraf output plugins
- Parses incoming Telegraf metrics and maps them to JSON-SCADA real-time data format
- Supports multiple Telegraf input sources (MQTT, Modbus, SNMP, OPC UA, etc.)
- The correlating Telegraf configs are in platform config dirs (e.g., `telegraf-input-*.conf`, `telegraf-output-json-scada.conf`)

## Verification

- `npm install` — dependencies install cleanly
- Send test Telegraf-formatted data via HTTP and verify it appears in MongoDB
