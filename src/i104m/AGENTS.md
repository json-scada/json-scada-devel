# DOX: src/i104m — I104M Legacy Adapter

## Purpose

Go-based legacy I104M adapter for compatibility with OSHMI protocol drivers. Translates between the I104M protocol and JSON-SCADA MongoDB data model.

## Ownership

- i104m owns the I104M protocol adapter

## Local Contracts

- **Language:** Go 1.21+
- **Single file:** `i104m.go`
- **Dependency management:** `go.mod` / `go.sum`
- **Build output:** `i104m.exe`
- **Config:** INI file via Supervisor

## Work Guidance

- Provides backward compatibility for OSHMI (Open Source HMI) protocol drivers
- Translates I104M-specific data formats to JSON-SCADA format
- Minimal driver — single-file Go application

## Verification

- `go build .` — compiles without errors
- Test with an OSHMI driver that uses I104M protocol
