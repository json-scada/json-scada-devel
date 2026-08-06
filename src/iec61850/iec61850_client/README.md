# IEC61850 Client (Go)

This driver implements a client for the IEC 61850 (MMS) protocol in Go, on top of
[go-iec61850](https://github.com/dscsystems/go-iec61850) — a pure-Go implementation of the
protocol stack.

It is a drop-in alternative to the C# driver in [src/iec61850_client](../../iec61850_client):
same `protocolDriver` name (`IEC61850`), same instance and connection documents, same tag
parameters, same MongoDB semantics. Everything in the C# driver's README applies here; this
document lists only what you need to run this binary and where the two differ.

    Binary:  iec61850-client (iec61850-client.exe on Windows)
    Service: JSON_SCADA_iec61850goclient (Windows), [program:iec61850goclient] (Linux)
    Log:     log/iec61850goclient.log

> **Enable either the C# `iec61850client` or the Go `iec61850goclient` for a given instance
> number — never both.** They would both go active on the same connections and duplicate every
> update.

The AdminUI needs no change: it already knows the `IEC61850` driver, and the connection form
already edits every parameter this driver reads.

## Switching an existing installation over

1. Build it (the platform build scripts already do this):

```bash
cd src/iec61850/iec61850_client && go build -o ../../../bin/iec61850-client
```

2. Stop and disable the C# service, then enable the Go one for the same instance number:

```bash
sudo supervisorctl stop iec61850client && sudo supervisorctl start iec61850goclient
```

3. Optionally point the AdminUI process manager at the Go binary by editing the `IEC61850`
   entry of `src/server_realtime_auth/app/services/process-manager/driver-catalog.js`:
   `exe: '{bin}/iec61850-client'`. Left alone, the catalog keeps managing the C# service.

No database change is needed. Tags, connections and instances carry over untouched, including
`lastReportIds`, so buffered reports resume where the C# driver left them.

## Command line arguments

    iec61850-client [instance [logLevel [configFile]]]

- **1st — Instance number** [Integer] — driver instance to run. *Optional, default 1*.
- **2nd — Log level** [Integer] — 0=minimum, 1=basic, 2=detailed, 3=debug. *Optional, default 1*.
- **3rd — Config file** [String] — path of `json-scada.json`. *Optional, default `../conf/json-scada.json`,
  then `c:/json-scada/conf/json-scada.json`*. The `JS_CONFIG_FILE` environment variable is also honoured.

Log level 3 additionally dumps the MMS protocol exchange (the equivalent of libiec61850's debug
output). Logging goes to stdout only; the service manager redirects it to the log file.

## Connection parameters

Every parameter documented in the [C# driver README](../../iec61850_client/README.md#configure-client-connections-to-iec61850-servers)
is read with the same meaning and the same default:

`protocolConnectionNumber`, `name`, `description`, `enabled`, `commandsEnabled`, `ipAddresses`
(only the first is used, `host[:port]`, default port 102), `topics` (report control blocks to
activate, empty means all), `autoCreateTags`, `timeoutMs`, `giInterval` (seconds between polls of
points not covered by a report), `class0ScanInterval` (report integrity period, seconds),
`password`, `useSecurity`, `localCertFilePath`, `privateKeyFilePath`, `peerCertFilesPaths`,
`rootCertFilePath`, `chainValidation`, `allowOnlySpecificCertificates`, `cipherList`,
`allowTLSv10`/`11`/`12`/`13`, and the parameters not exposed in the AdminUI: `useBrcb`, `useUrcb`,
`browse`.

`timeoutMs` is used here as the connect and per-request budget; the C# driver reads it but never
applies it.

TLS notes: certificates may be PEM or DER. `chainValidation: false` skips chain verification;
`allowOnlySpecificCertificates: true` pins the peer to `peerCertFilesPaths`. The version window is
the lowest to the highest enabled flag. Go does not negotiate TLS 1.0/1.1, so a request for them is
clamped to TLS 1.2 and logged. The default port for MMS over TLS is 3782 — put it in `ipAddresses`
explicitly, since the default here stays 102 for compatibility.

## Tag parameters

Identical to the C# driver: `protocolSourceConnectionNumber`, `protocolSourceCommonAddress` (the
functional constraint — `ST`, `MX`, `CO`, …), `protocolSourceObjectAddress` (the IEC 61850 object
reference), `protocolSourceASDU` (unused), `kconv1`, `kconv2`.

Commands use `protocolSourceCommonAddress: "CO"` for a control object; any other functional
constraint performs a plain MMS write. `protocolSourceCommandUseSBO` forces select-with-value on a
normal-security SBO object; otherwise the control model decides the sequence.

Automatically created tags are named `IEC61850;<connection>;<object reference>[<FC>]`, exactly as
the C# driver names them, and are allocated `_id`s from the range
`protocolConnectionNumber * 1000000`.

## Differences from the C# driver

Behaviour is reproduced deliberately, including several quirks (see below). These are the
intentional differences:

| # | Difference | Why |
|---|---|---|
| D1 | A command expires after 10 seconds of total age | The C# driver tests the *seconds component* of the age, which wraps every minute and lets much older commands through |
| D2 | Integer, float, double-point and analogue (APC) controls receive a correctly typed `ctlVal` | The C# driver sends a boolean for every direct-model control, so analogue setpoints cannot work |
| D3 | `valueBsonAtSource` is strictly valid JSON (no trailing comma, strings escaped) | The C# output relies on a lenient parser; the stored document is equivalent |
| D4 | Terminates on SIGINT/SIGTERM instead of the `Esc` key | Portability; services have no console |
| D5 | The TLS version window is the lowest to the highest enabled flag | The C# cascade can produce a minimum above its maximum |
| D6 | A rejected point read no longer drops the association | The C# driver could not tell a bad point from a dead link |
| D7 | The banner names go-iec61850 | It is not libiec61850 |
| D8 | Polling issues its reads concurrently, bounded by the association's negotiated limit | One sweep costs about one round trip instead of one per point |
| D9 | Transient detection on a two-member structure tests the bit-string member | The equivalent C# call raises an exception on that path |
| D10 | Reports are not asked to carry data references | Entries are identified from the data set members and the reference strings are discarded, so requesting them only adds traffic — and a server that announces them without sending them would desynchronise the whole report |
| D11 | One report control block per data set is activated, a buffered one by preference | A server offers several blocks over the same data set — indexed instances, spares for other clients, a buffered and an unbuffered one — and every one delivers the same values, so each tag would be written once per block. The C# driver enables them all. A buffered block is chosen when the data set has one, because its stream survives a disconnection, which is what the EntryID resync is for. |
| D12 | A report that carries no reason codes at all is still forwarded | The inclusion bitstring already says which members are included; the C# equivalent would drop the whole report on a server that ignores the requested optional fields |

Reproduced on purpose, because tags fed by either driver must not disagree:

- For a structured value, quality, transient state and timestamp are taken from the **last**
  member of the structure. For the usual `{stVal, q, t}` this means the timestamp member has the
  last word and quality reads as good.
- The realtimeData update filter carries no functional constraint, so two tags of one connection
  sharing an object address under different constraints update each other.
- `valueBsonAtSource` keeps its `{ a: <value> }` wrapper.
- Points that belong to an activated report are still polled until their first report arrives.
- Only points seen in reports are auto-created; polled-only points are not.
- Automatically created tags carry `group3` with the functional constraint as written, and
  `alarmState` 2 for digitals, -1 otherwise.

## Testing

```bash
cd src/iec61850/iec61850_client && go test ./...
```

The suite covers the value conversions and the tag documents, and runs the driver against an
in-process IEC 61850 server built from `testdata/simpleIO_direct_control.cid`: discovery, several
report control blocks active at once, general interrogation, spontaneous data change, reports
carrying data references, polling, control and plain MMS write, and connection-loss detection. No
MongoDB or network device is needed.

For an end-to-end check with a database, seed an instance and a connection, point them at any IEC
61850 server, and watch the tags:

```bash
mongosh json_scada --eval 'db.realtimeData.find({protocolSourceConnectionNumber:9300},{tag:1,sourceDataUpdate:1}).limit(5)'
```

## Design notes

The full design, the parity rules and the analysis of the library are in
[GO_DRIVER_PLAN.md](GO_DRIVER_PLAN.md).
