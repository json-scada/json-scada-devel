# DOX: src/iccp — ICCP TASE2 Protocol Drivers

## Purpose

ICCP (IEC 60870-6 / TASE.2) client and server protocol drivers for JSON-SCADA, written in Go. Provides interoperability with utility control center systems using the ICCP/TASE.2 standard.

## Ownership

- iccp owns the ICCP client and server implementations
- The tase2 subdirectory contains the TASE2 library dependency
- Interop boundaries: MongoDB change streams (in), real-time data events (out)

## Local Contracts

- **Language:** Go (1.21+)
- **Dependencies:** `go.mod` / `go.sum`
- **Build:** `go build` in component directories
- Sub-projects:
  - `iccp-client/` — ICCP TASE.2 client driver
  - `iccp-server/` — ICCP TASE.2 server driver
  - `tase2/` — TASE.2 communication library (closed source, 100% native Go)
- Configuration via the central `json-scada.json` or environment variables
- Uses MongoDB Go driver for database access

## Work Guidance

- ICCP uses the TASE.2 MMS protocol — be familiar with IEC 60870-6 standards
- The TASE2 library is closed source; treat as an opaque dependency
- Client side: initiate connections to remote ICCP servers
- Server side: accept connections from remote ICCP clients
- Both sides: support TCP/TLS transport
- Follow Go idioms: `error` returns, `context.Context`, idiomatic naming

## Verification

- `go build ./...` in the iccp directory
- `go test ./...` (if tests exist)
