# DOX: src/grafana_alert2event — Grafana Alert to SCADA Event Bridge

## Purpose

Node.js service that converts Grafana alerts to JSON-SCADA events. Listens for Grafana webhook notifications and writes them to the SOE (Sequence of Events) MongoDB collection.

## Ownership

- grafana_alert2event owns the Grafana alert integration

## Local Contracts

- **Language:** Node.js
- **Main entry:** `grafana_alert2event.js` — single-file application
- **Config:** Environment variables or command-line arguments

## Work Guidance

- Receives Grafana alert webhooks via HTTP POST
- Maps Grafana alert fields to JSON-SCADA event schema
- Writes events to the SOE collection for alarm management

## Verification

- Test with a simulated Grafana alert webhook payload
