# IEC 61850 Server (Go)

This driver exposes the JSON-SCADA real-time database as an **IEC 61850 MMS server**, acting as a
telecontrol gateway / proxy in the sense of **IEC 61850-90-2**. It is written in Go on top of
[go-iec61850](https://github.com/dscsystems/go-iec61850), a pure-Go implementation of the protocol
stack, so **no native library is required**.

It is a drop-in alternative to the C# driver in [src/iec61850_server](../../iec61850_server): same
`protocolDriver` name (`IEC61850_SERVER`), same connection document, same model layout and object
references, same `commandsQueue` documents. Everything in the C# driver's README applies; this
document lists what you need to run this binary and where the two differ.

    Binary:  iec61850-server (iec61850-server.exe on Windows)
    Service: JSON_SCADA_iec61850goserver (Windows), [program:iec61850goserver] (Linux)
    Log:     log/iec61850goserver.log

> **Enable either the C# `iec61850server` or the Go `iec61850goserver` for a given instance
> number — never both.** They would bind the same port and answer as the same IED.

The AdminUI needs no change: it already knows the `IEC61850_SERVER` driver.

## How it works

1. On startup the driver reads its single `protocolConnections` document, then queries
   `realtimeData` for points whose `group1` is in `topics` (excluding internal points, points that
   originate from this same connection, and — when `commandsEnabled` is false — command points).
2. It **builds an IEC 61850 data model** (no SCL file needed):
   - one **logical device per topic** (`group1`), plus a default `GEN` device for points with none;
   - each device gets `LLN0` (Beh/Health/NamPlt/LastApplError) and `LPHD1` with `Proxy.stVal = TRUE`,
     the IEC 61850-90-2 gateway marker;
   - points become **GGIO** data objects, at most 30 per instance; further points open `GGIO2`,
     `GGIO3`, … Each instance numbers its own objects from 1, as real IEDs do:

     | JSON-SCADA point | CDC | GGIO object |
     |---|---|---|
     | digital monitor | SPS | `Indn` (`stVal`) |
     | analog monitor | MV | `AnInn` (`mag.f`) |
     | string monitor | VSS | `Strn` (`stVal`) |
     | digital command | SPC | `SPCSOn` |
     | analog command | APC | `AnOutn` |

   - per-device **data sets** (`DS_ST_k` status, `DS_MX_k` measurand, ≤40 entries each) and
     **buffered + unbuffered report control blocks** (`brcbST0101`, `urcbST0101`, …), one pair per
     data set with as many instances as `maxClientConnections` (capped at 4).
3. A **MongoDB change stream** pushes value, quality and timestamp updates into the model; the
   library handles reporting, buffering, integrity scans and general interrogation.
4. IEC 61850 **control operations** (SPC/APC) become `commandsQueue` documents, which JSON-SCADA
   routes to the driver that owns the source point.

A **mapping manifest** (`log/iec61850_server_map_<conn>.json`) listing every tag → object reference
is written at startup.

## Command line

```
iec61850-server [instance [logLevel [configFile]]]
```

```
iec61850-server selftest [port [bulkPoints]]
```

- **instance** — `protocolDriverInstanceNumber`. *Optional, default 1*.
- **logLevel** — 0=none, 1=basic, 2=detailed, 3=debug (3 also traces MMS PDUs). *Optional, default 1*.
- **configFile** — path of `json-scada.json`. *Optional, default `../conf/json-scada.json`, then
  `c:/json-scada/conf/json-scada.json`*. `JS_CONFIG_FILE` is also honoured.
- **selftest** — builds and serves a synthetic model without MongoDB, so the model can be browsed
  with any IEC 61850 client. `bulkPoints` adds N extra points to exercise the layout at scale.

## Connection configuration (`protocolConnections`)

| Field | Meaning |
|---|---|
| `protocolDriver` | `"IEC61850_SERVER"` |
| `protocolConnectionNumber` | unique connection number (also the loop-prevention key) |
| `name` | connection name — sanitized into the **IED name** |
| `topics` | list of `group1` values to expose (empty = all points) |
| `commandsEnabled` | allow IEC 61850 controls → `commandsQueue` |
| `ipAddressLocalBind` | `ip:port` to bind (default `0.0.0.0:102`, `:3782` when `useSecurity`) |
| `ipAddresses` | optional allow-list of client IPs (others are disconnected) |
| `serverModeMultiActive` / `maxClientConnections` | max simultaneous MMS clients, and the number of report control block instances per data set |
| `maxQueueSize` | buffered-report depth, in **reports** per buffered control block |
| `useSecurity` + `localCertFilePath` / `privateKeyFilePath` / `rootCertFilePath` / `peerCertFilesPaths` / `chainValidation` / `allowOnlySpecificCertificates` / `allowTLSv1x` / `cipherList` | IEC 62351-3 TLS |
| `password` | ACSE password (accepted, not enforced — see D4) |

Example:

```json
{
  "protocolDriver": "IEC61850_SERVER",
  "protocolDriverInstanceNumber": 1,
  "protocolConnectionNumber": 8001,
  "name": "IEC61850SRV",
  "description": "IEC61850-90-2 Gateway Server",
  "enabled": true,
  "commandsEnabled": true,
  "ipAddressLocalBind": "0.0.0.0:102",
  "topics": ["KAW2", "KIK3"],
  "serverModeMultiActive": true,
  "maxClientConnections": 4,
  "maxQueueSize": 5000,
  "useSecurity": false
}
```

## Model sizing

The model is bounded so that no MMS response grows past what a client with a small negotiated PDU
can take. The bounds are the C# driver's, so a client sees the same model shape from either driver:

| Bound | Default | Why |
|---|---|---|
| objects per logical node | 30 | a logical node's type description is returned in one response |
| entries per data set | 40 | reading a data set returns every member at once |
| report control blocks per LLN0 | 7 | `LLN0[BR]`/`[RP]` returns every block of that family at once |
| RCB copies per data set | 4 | each instance multiplies that response |
| description length | 32 | `d` is published per object and one `[DC]` read returns them all |
| string point cost | 8 | a string value can be far larger than a status or measurand |

Points per logical device are derived from `maxClientConnections`, and topics larger than the limit
are split across several logical devices (`KAW2`, `KAW2_2`, …). The bounds are logged at startup:

```
Model bounds: 2 RCB copies/data set, <= 80 points per logical device,
              <= 40 entries per data set, <= 30 objects per logical node
Topic 'BULK' has 3000 points - split across 38 logical devices.
```

Unlike libiec61850, the Go stack does not refuse oversized responses (COTP segments them), so these
bounds protect clients rather than the server.

## Notes and limitations

- **Static model**: the model is fixed at startup. Tags added later are not exposed until the driver
  is restarted; matching updates for unknown tags are logged at level 2.
- **Redundancy**: only the active instance serves clients; the standby keeps the MMS server stopped
  so clients never read stale data.
- **Port 102 on Linux** needs privileges: `setcap 'cap_net_bind_service=+ep' bin/iec61850-server`,
  or use a port above 1024 in `ipAddressLocalBind`.
- GOOSE/SV publishing, setting groups, log services and SCL export are out of scope.

## Differences from the C# driver

| # | Difference | Why |
|---|---|---|
| D2 | `maxQueueSize` counts **reports** per buffered control block, not bytes | The C# converts it to a byte budget at ~128 B/entry for libiec61850; this library counts reports |
| D4 | `password` (ACSE authentication) is accepted but not enforced | The Go server does not check ACSE authentication values |
| D5 | `RptID` is set to each control block instance's own object reference | Which is the default IEC 61850-8-1 prescribes and what libiec61850 sends; see the workaround note below |
| D6 | The mapping manifest is sorted by `pointKey` | The C# writes map-iteration order, which is unstable between runs |
| D8 | Terminates on SIGINT/SIGTERM | Services have no console |
| D9 | The banner names go-iec61850 | It is not libiec61850 |

**Library workaround in force:** go-iec61850 composes a report control block's default `RptID` from
the *configured* block name rather than the materialised instance name, so `brcbMX01` with two
instances would have both report `LD/LLN0$BR$brcbMX01` — a block that does not exist, and the same
identifier for both. Clients that bind an incoming report to the block they enabled (IEDExplorer
among them) then cannot attach the values to their model, and structured attributes such as `mag`
never appear. `fixReportIDs` in `server.go` rewrites each instance's `RptID` to its own object
reference after the model is materialised, which is what libiec61850 sends. Remove it once the
library fixes `rcbRptID`.

Reproduced on purpose, so both drivers present the same gateway: the model layout and object
references, the sizing bounds, description truncation, `invalid` treated as true when the field is
missing, command points excluded from data sets and never written from the database, and one
logical device per topic with the same splitting rule.

## Testing

```bash
cd src/iec61850/iec61850_server && go test ./...
```

The suite covers the model builder (layout, packing, splitting, data sets, report controls, control
models, truncation), the update path (quality mapping, per-class value placement, time quality) and
the command documents, and it runs the server against the library's own IEC 61850 client
in-process: browse, read, data set read, GI, data-change reporting, direct/analogue/SBO controls,
refusal while inactive, the client allow-list, the connection cap and a stop/start cycle. No
MongoDB or network device is needed.

To eyeball the model with any client:

```bash
./iec61850-server selftest 10102
```

## Design notes

The full design, the parity rules and the analysis of the library are in
[GO_DRIVER_PLAN.md](GO_DRIVER_PLAN.md).
