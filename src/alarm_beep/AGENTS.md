# DOX: src/alarm_beep — Alarm Audio Notification

## Purpose

Node.js service that monitors MongoDB Change Streams for alarm events and plays audio notifications. Provides audible alerts for SCADA alarms.

## Ownership

- alarm_beep owns the alarm audio notification system

## Local Contracts

- **Language:** Node.js
- **Main entry:** `alarm_beep.js`
- **Pattern:** standard Node.js app (`app-defs.js`, `load-config.js`, `simple-logger.js`)
- **Config:** INI file via Supervisor or environment variables

## Work Guidance

- Subscribes to alarm events via MongoDB Change Streams
- Plays configurable audio files for different alarm severities
- Supports configurable alarm filtering by point, area, or severity

## Verification

- `npm install` — dependencies install cleanly
- Test with alarm-producing data and verify audio playback
