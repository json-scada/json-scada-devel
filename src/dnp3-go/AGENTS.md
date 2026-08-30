# DOX: src/dnp3-go — DNP3 Client and Server Drivers (Go)

## Purpose

Pure-Go DNP3 master and outstation drivers for JSON-SCADA. Drop-in alternatives to the C++
drivers in `src/dnp3`: same `protocolDriver` names (`DNP3`, `DNP3_SERVER`), same configuration
documents, same MongoDB semantics, no opendnp3, mongo-cxx-driver, OpenSSL, vcpkg or CMake.

## Ownership

- dnp3-go owns the Go implementation of both DNP3 drivers
- `src/dnp3` (C++) remains the reference implementation; behaviour is matched to it

## Local Contracts

- **Language:** Go 1.26, module `dnp3-go`, `cmd/` + `internal/` layout as in `src/iec60870-5`
- **Library:** `github.com/dscsystems/go-dnp3` v0.2.0 (GPLv3+, pure Go) — **pin the version**,
  the API is pre-1.0 and the SKILL.md in that repo says so explicitly. JSON-SCADA is GPL-3.0, so
  the copyleft is not a problem; note it rather than re-litigating it.
- **Binaries:** `dnp3-client(.exe)` and `dnp3-server(.exe)`. They must **not** collide
  case-insensitively with `Dnp3ClientCpp.exe` / `Dnp3Server.exe`, so both implementations can
  live in `bin/` during migration. Do not rename them to `dnp3client` / `dnp3server`.
- **Packages:**
  - `cmd/dnp3client`, `cmd/dnp3server` — entry points, banner, CLI, config file
  - `internal/jscfg` — json-scada.json, CLI args, the levelled logger, the slog bridge
  - `internal/mongoutil` — permissive BSON accessors, client factory, liveness
  - `internal/redundancy` — active/standby arbitration and keep-alive
  - `internal/dnp3util` — group tables, quality mapping, CROB codes, endpoints, the
    `multidrop.Bus` grouping layer, the counting and link-state channel wrappers
  - `internal/clientapp` — the master driver (← `Dnp3ClientCpp`)
  - `internal/serverapp` — the outstation driver (← `Dnp3Server`)
- **Build:** `build.bat`, or `go build -ldflags="-s -w" -o ../../bin/dnp3-client ./cmd/dnp3client`
- **Config:** `conf/json-scada.json` plus MongoDB documents; CLI `<instance> <logLevel> <configFile>`

## Work Guidance

- The C++ drivers are the specification. Before changing behaviour, check what `src/dnp3` does.
  Quirks are reproduced on purpose and marked `parity:` in comments; intentional differences are
  numbered D1..D23 in `README.md` — add to that list rather than diverging silently.
- Only `sourceDataUpdate` is written for client data; never the tag `value`, alarms or history.
- All numbers written to MongoDB must be Go `float64` so they land as BSON doubles. The `stats`
  counters are the exception: they are `int64`, as in the C++ drivers.
- **Do not set a client-level `Timeout` on the MongoDB client.** It applies to every operation
  including a change stream's `Next`, so the watchers get torn down and rebuilt on each expiry.
  Every call that needs a bound passes its own context deadline.
- **Periodic class scans must be re-registered on every connection.** `master.Session.Run` calls
  its startup sequence on each connect, and that begins by clearing the task scheduler — a scan
  registered once is dropped, and the session then polls nothing but its own startup integrity
  read. `classScanLoop` watches `Connected()` and re-registers on each rising edge.
- **Configure the analog variations explicitly.** go-dnp3 defaults analogs to the 32-bit integer
  variations, so an unconfigured point truncates 123.5 to 123. The server applies g30v5/g32v7 to
  every analog and g40v3/g42v7 to every analog output status, as the C++ server does.
- `Database.Configure` replaces the whole `PointConfig`, so every call is a read-modify-write: a
  zero `Class` is `ClassNone` and silently kills the point's events.
- An outstation has no `Connected()`. Read the link state from the channel the session runs on
  (`dnp3util.WrapLinkState`), never from traffic: the default integrity interval is 300 seconds,
  so an idle-looking station is normal.
- Multi-drop is `multidrop.Bus`, not hand-written framing. Every connection goes on a bus,
  single-station ones included, because the frame and CRC statistics come from it.
- **The active channels are built with `channel.NoRetry` and the driver retries in `countchan`.**
  Do not put the retry back into the library channel: it loops inside `Connect` and returns only
  a context error at the end, so `numOpenFail` never increments and the reason the port would not
  open is lost. In that retry loop, `channel.ErrClosed` and a cancelled context must propagate
  rather than be retried: both are an orderly shutdown, a closed channel can never produce a
  connection, and retrying hides the shutdown signal from the session.

## Verification

- `go test ./...` — conversion tables, variation tables, tag documents, grouping and conflict
  detection, plus loopback runs of a real master against a real outstation over `channel.Pipe`
  and over a real mutually authenticated TLS socket. No MongoDB and no hardware needed; the TLS
  tests generate their own certificates into `t.TempDir()`.
- `go vet ./...` and `gofmt -l .` must be clean; `go test -race ./...` for the concurrency.
- End to end: a temporary `mongod` as a single-node replica set (change streams need one), seeded
  with an instance, connections and tags, then both drivers against each other on port 20000.
  Check `sourceDataUpdate`, `stats.isConnected`, the auto-created tags, and that a document
  inserted into `commandsQueue` comes back with `delivered`/`ack`/`resultDescription`.
- Serial: `TestSerialPortPair` carries a real session over two real ports and skips unless
  `-serial.a` and `-serial.b` name a pair, so the gap closes the moment one exists —
  `socat -d -d pty,raw,echo=0 pty,raw,echo=0` on Linux, com0com on Windows (an elevated install).
  Everything else about serial operation is covered without hardware: the configuration mapping,
  the open-failure path, and the link-layer confirmation and arbitration that serial mode turns
  on. A virtual pair could not be created on the development machine used here — WSL2 needs
  virtualization that is not enabled, and com0com needs elevation and, on current Windows, test
  signing, which is a security control not worth disabling for a test.

## Known gaps

- Octet strings (groups 110/111) are decoded and discarded, as in the C++ drivers.
- Group 50 (time and interval) destinations are unsupported: `outstation.DatabaseConfig` has no
  such family.
- A passive TCP/TLS connection serves one master connection at a time; the bus multiplexes
  outstations, not masters.
- CROB durations 10, 12, 20 and 22 are documented in the driver README but were never implemented
  by the C++ switch; they behave as NUL. Reproduced deliberately.
