# DOX: src/backup-mongo — MongoDB Backup Utility

## Purpose

Node.js utility for automated MongoDB backup of JSON-SCADA databases. Configurable backup schedules and retention policies.

## Ownership

- backup-mongo owns the MongoDB backup automation

## Local Contracts

- **Language:** Node.js
- **Main entry:** `backup-mongo.js`
- **Pattern:** standard Node.js app (`app-defs.js`, `load-config.js`, `simple-logger.js`)
- **Config:** INI file via Supervisor or environment variables

## Work Guidance

- Uses `mongodump` under the hood for consistent backups
- Configurable backup directory, schedule, and retention
- Supports backup of specific databases and collections
- Can be run as a scheduled task or on-demand

## Verification

- Test backup and restore with sample MongoDB data
