# IEC 60870-5-101/104 Client and Server Drivers (Go)

Go reimplementation of the four JSON-SCADA IEC 60870-5 protocol drivers, built
on the [go-iecp5](https://github.com/riclolsen/go-iecp5) library. These are
**drop-in replacements** for the legacy C# drivers in
[`../lib60870.netcore`](../lib60870.netcore): same protocol driver names, same
MongoDB collections and field semantics, same command-line contract and same
binary names, so AdminUI, the service definitions and the demo configurations
work unchanged.

| Binary | Protocol driver name | Role | Transport |
|---|---|---|---|
| `iec104client` | `IEC60870-5-104` | Master (client) | TCP/IP (+TLS) |
| `iec104server` | `IEC60870-5-104_SERVER` | Outstation (server) | TCP/IP (+TLS) |
| `iec101client` | `IEC60870-5-101` | Primary station (master) | Serial (unbalanced) |
| `iec101server` | `IEC60870-5-101_SERVER` | Secondary station (outstation) | Serial (unbalanced) |

## Command line

```
iec10Xclient|server [instanceNumber [logLevel [configFileName]]]
```

- `instanceNumber` — driver instance number (default `1`).
- `logLevel` — `0` none, `1` basic (default), `2` detailed, `3` debug. Level 3
  additionally enables the go-iecp5 protocol logger.
- `configFileName` — path to `json-scada.json`; defaults to
  `../conf/json-scada.json`, then `c:/json-scada/conf/json-scada.json`. The
  `JS_CONFIG_FILE` environment variable is also honored.

## Source Code Layout

```
cmd/                 one main package per binary (thin: wire config -> shared engines -> endpoint)
internal/
  jscfg/             json-scada.json + CLI args + log formatting
  mongoutil/         Mongo connect (TLS via URI), permissive numeric decode, instance/conn loading
  model/             protocolConnections / realtimeData / instances document structs
  redundancy/        active-node arbitration (clients), connection-stats updates
  conv/              ASDU encode (BuildInfoObj) / decode / batched send — the protocol core
  cliapp/            client engine: data queue -> Mongo bulk writer, command change stream, autoCreateTags
  srvapp/            server engine: realtimeData change stream, spontaneous batcher, interrogation,
                     command validation/forwarding, DistributeAutoTags
  cs101util/         serial + link config mapping for the 101 drivers
  tlsutil/           *tls.Config from the connection certificate fields (PFX or PEM)
test/                protocol-level loopback tests (no MongoDB required)
```

## Building

Handled by the platform build scripts (`platform-windows/build.bat`,
`platform-linux/build.sh`, and the RHEL/Ubuntu installers). Manually:

```sh
cd src/iec60870-5
go build -o ../../bin/iec104client ./cmd/iec104client
go build -o ../../bin/iec104server ./cmd/iec104server
go build -o ../../bin/iec101client ./cmd/iec101client
go build -o ../../bin/iec101server ./cmd/iec101server
```

## Configuration fields

All `protocolConnections` fields honored by the C# drivers are honored here.
Notable mappings and current limitations:

- **104 client dual-server failover** (`ipAddresses[0]` / `[1]`) is managed by
  the driver: on connection loss it swaps to the other address and reconnects.
- **104 server client whitelist** (`ipAddresses`): empty or `["*"]` accepts any
  client; otherwise the connecting IP must be listed. `maxClientConnections` is
  enforced by the driver.
- **TLS** (`localCertFilePath` + `passphrase`, `peerCertFilesPaths`,
  `rootCertFilePath`, `chainValidation`, `allowOnlySpecificCertificates`) is
  supported; the certificate file may be a `.pfx`/`.p12` (as in the C# drivers)
  or a PEM file containing the certificate and key.
- **101 serial** (`portName`, `baudRate`, `parity`, `stopBits`) maps to the
  go-iecp5 serial config. Serial `handshake` other than `none` is not applied.
  `timeoutForACK`/`timeoutRepeat` (ms) are converted to whole-second T1/T2.

### Known limitations vs. the C# drivers

- `portName = "host:port"` (TCP virtual serial) is not yet supported by the 101
  drivers.
- 104 client connection statistics currently report `isConnected` only; the
  detailed APCI counters are not yet exposed by go-iecp5 (gap G4).
- `serverModeMultiActive=false` (single-redundancy-group buffering) is emulated
  with a bounded FIFO held while no master is connected (gap G3).

## Behavior parity notes

Replicated intentionally from the C# drivers:

- CP24-tagged values always write `timeTagAtSourceOk=false` (the C# driver tests
  an unused CP56 placeholder). CP56-tagged values set it from the time validity.
- Step-position `transient` is merged into invalid quality on decode.
- The 104/101 servers use a single process-wide "selected point" slot for SBO.
- Client commands read from `commandsQueue` are sent without kconv conversion.
- Command-expiry windows: 10 s on the client side, 20 s for time-tagged commands
  on the server side.
- Counter re-initialization offsets on (re)connect (`giInterval-3`/`-2`, etc.).

## Testing

```sh
go test ./internal/conv/   # encode/decode parity unit tests
go test ./test/            # cs104 client <-> server protocol loopback (no MongoDB)
```

The loopback test wires a go-iecp5 server and client over `127.0.0.1` and checks
interrogation data and a control command round-trip through the `conv` package.
Full end-to-end verification against a running JSON-SCADA MongoDB, and interop
against the legacy C# drivers, is described in `GO_DRIVERS_PLAN.md`.
