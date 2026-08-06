# Plan: IEC 61850 MMS Server Driver in Go (`src/iec61850/iec61850_server`)

Target directory: `src/iec61850/iec61850_server` (to be created)
Library: [github.com/dscsystems/go-iec61850](https://github.com/dscsystems/go-iec61850) **v0.2.3** — pure Go (no cgo), GPL-3.0, `go 1.26.5`
Reference implementation to replicate: `src/iec61850_server` (C#/.NET 8 + `IEC61850.NET.core.2.0` over libiec61850), driver version `0.1.0`
Companion: the Go **client** driver already delivered at [`src/iec61850/iec61850_client`](../iec61850_client) — same module conventions, same parity discipline, and the natural loopback partner for testing this one.

**Goal:** a behavioural clone of the C# `IEC61850_SERVER` driver — same `protocolDriver` name, same CLI contract, same connection parameters, the same model shape presented to IEC 61850 clients, the same `commandsQueue` documents — with no native dependency.

> **Revision note (v0.2.1 → v0.2.2 → v0.2.3).** The first version of this plan carried eleven library gaps. They are now all closed.
> **v0.2.2** brought `model.NewDataObject` (the common data classes, replacing ~350 lines of hand-built attribute trees), `WithMaxConnections` + `OnConnection` + `OpenConnections` (replacing a custom `net.Listener` wrapper), `ControlCtx.Conn`/`.Peer` (the originator's real address), and `WithReportBufferSize` + `ReportControl.MaxQueueSize` (a configurable buffered-report depth).
> **v0.2.3** closes the last two, including the one that shaped the design: `reporting.go:memberChanged` now matches a data-set member against changes **in both directions**, so a **DO-level FCDA** — the form the C# driver uses, carrying `stVal`+`q`+`t` as one structure — is triggered by a change to any attribute below it; and `CDCVSS` exists, so string points need no hand-built object.
> **Consequence: the model this driver serves is now identical to the C# driver's**, data-set composition included. The former deviation E1 is gone, the sizing constants revert to the C# values verbatim, and nothing about the model is a compromise any more. Sections 2, 3, 6, 12, 14, 15 and 16 are revised; the parity rules in sections 4, 5, 7, 8, 9, 10 and 11 describe the C# behaviour and are unchanged.

---

## 0. Decisions taken up front

| Question | Decision | Rationale |
|---|---|---|
| `protocolDriver` name | **`IEC61850_SERVER`** (unchanged) | AdminUI, `driver-catalog.js` (`key: 'iec61850server'`) and the schema already know it. A drop-in alternative, not a new protocol. |
| Binary name | **`iec61850-server`** / `.exe` | Must differ from the C# `iec61850_server(.exe)` so both can sit in `bin/`. Matches the client driver's `iec61850-client`. |
| Coexistence | *Enable EITHER `iec61850server` (C#) OR `iec61850goserver` (Go) for a given instance number, never both* | They would bind the same port and answer as the same IED. Established `plc4x`/`plc4j` and `iec61850client`/`iec61850goclient` precedent. |
| Go module name | `iec61850_server` | Repo convention. |
| Package layout | Flat `package main`, one file per C# file | Keeps the two implementations diffable, as in the client driver. |
| Mongo driver | `go.mongodb.org/mongo-driver/v2` | Same as every other Go driver here. |
| Logging | `log.go` copied from the Go client driver | Identical operator experience across the two Go drivers. |
| Driver version | `0.1.0`, announced as `{json:scada} IEC61850 Server Driver (IEC61850-90-2, Go) - Copyright 2020-2026 Ricardo Olsen` | Distinguishable from the C# banner in `log/`. |

---

## 1. What the C# driver does (the specification)

A gateway/proxy in the sense of **IEC 61850-90-2**: it takes the points of `realtimeData` selected by `topics` (matched on `group1`), lays them out as a synthetic IEC 61850 model, serves them over MMS with reporting, and turns client control operations back into `commandsQueue` documents.

```
realtimeData ──change stream──▶ update queue ──▶ IEC 61850 model ──reports──▶ MMS clients
commandsQueue ◀──insert──── control handler ◀──Oper/SBOw──────────────────── MMS clients
protocolDriverInstances ──redundancy──▶ start/stop the MMS server
```

Startup sequence (`Main.cs`), reproduced step for step:

1. parse args, read `json-scada.json`, validate the instance document;
2. load the **single** enabled connection of this instance (warn and use the first if several);
3. parse `ipAddressLocalBind` into bind address + port (default `0.0.0.0`, port 102, or 3782 when `useSecurity`);
4. query the points to expose;
5. **build the model** and write the mapping manifest;
6. create the server (not started);
7. start the redundancy, change-stream, model-update and command-inserter goroutines;
8. loop at 1 Hz: start the MMS server when this node is active, stop it when it is not, and log the open-connection count when it changes.

---

## 2. Library assessment (v0.2.3)

### 2.1 API surface this driver uses

```
model:  NewDataObject(name string, cdc CDC, opts ...CDCOption) *DataObject
        CDCSPS CDCINS CDCENS CDCMV CDCSPC CDCAPC CDCDPC CDCINC CDCLPL CDCDPL …
        WithOptional(names ...string)      // "d", "instMag", …
        WithControlModel(CtlModel)         // builds Oper/SBOw/SBO/Cancel + ctlModel
        WithIntegerAnalogue() | WithoutCancel() | WithSettingFC(fc)
        CDCAttributes(cdc) | CDCControlValue(cdc) | CDCSubObjects(cdc) | KnownCDCs()
        Model / LogicalDevice / LogicalNode / DataObject / DataAttribute
        DataSet{Name, Entries []FCDA{Ref, FC}}
        ReportControl{Name, RptID, DataSet, ConfRev, Buffered, BufTime, TrgOps,
                      OptFlds, IntgPd, RptEnabled, MaxQueueSize}
        Quality (WithValidity, flags) / TrgOps / OptFlds / CtlModel / AddCause / OrCat

server: New(m, opts...) *Server
        WithIdentity | WithTLS | WithLogger | WithMaxConnections(n) | WithReportBufferSize(n)
        (*Server) Serve(ln) | ListenAndServe(addr) | Close()
        (*Server) Update(func(tx *Tx)) | Read(ref, fc)
        (*Server) OnControl(ref, ControlHandler) | OnWrite(h)
        (*Server) OnConnection(func(ConnectionEvent)) | OpenConnections() | MaxConnections()
        ConnectionEvent{Peer, Addr, State (Opened|Closed|Refused), Open, Conn}
        ControlCtx{Ref, Value, Origin, OrIdent, CtlNum, Test, Interlock, Synchro, Select,
                   Conn, Peer}
        Tx: Set / SetBool / SetFloat32 / SetInt32 / SetQuality / SetTimestampNow / Get / Toggle
```

Implemented server-side: browse, read/write, data sets, **buffered and unbuffered RCBs** with GI, integrity period, data-change triggers, EntryID resync, `PurgeBuf` and a configurable buffer depth, **controls in all four models** including SBO-with-normal-security (select by reading `$SBO`) and SBOw with ctlNum checking, `LastApplError` population, CommandTermination for enhanced models, TLS.

### 2.2 Gap analysis versus the C# `IedServer`

| # | C# capability | v0.2.3 | Plan |
|---|---|---|---|
| **S1** | `SetConnectionIndicationHandler` (connect/disconnect logging + IP allow-list + `con.Abort()`), `MaxMmsConnections`, `GetNumberOfOpenConnections()` | **Fixed.** `WithMaxConnections(n)` refuses at the transport before any association; `OnConnection(func(ConnectionEvent))` reports `Opened`/`Closed`/`Refused` with `Peer`, `Addr`, the running `Open` count and the `*mms.ServerConn`; `OpenConnections()` reads the count. | No custom listener. Log from the handler, and enforce the `ipAddresses` allow-list by closing `ev.Conn` on `ConnectionOpened` — which is exactly what the C# does with `con.Abort()`. §7 |
| **S2** | `IedServerConfig.ReportBufferSize` derived from `maxQueueSize` | **Fixed.** `WithReportBufferSize(n)` sets the server default; `ReportControl.MaxQueueSize` overrides per control block. | Pass `maxQueueSize` (reports, not bytes) as the server default and log the effective depth. Note the unit change: the C# converts to bytes at ~128 B/entry, the library counts reports (deviation **E2**). |
| **S3** | `Start()` / `Stop()` on redundancy transitions, model built once | `Close()` then `ListenAndServe()`/`Serve()` again on the same `*Server` | Unchanged: build the model once, `server.New` once, then start/stop. **Never** call `server.New` twice on one model — it materialises report control blocks *into* the model and a second call would duplicate every RCB. Covered by a test (§12.2 case 7). |
| **S4** | `CDC.Create_CDC_SPS/MV/VSS/SPC/APC/ENS/INS/LPL/DPL` | **Fixed.** `model.NewDataObject(name, cdc, opts...)` builds mandatory attributes, requested optional ones and nested objects, with zero values of the right types; `WithControlModel` emits the control attributes and `ctlModel`. Verified: the control structure is exactly the six-member form `server/control.go:decodeOper` indexes — `{ctlVal, origin{orCat, orIdent}, ctlNum, T, Test, Check}`. `CDCVSS` arrived in v0.2.3, so every class this driver needs is generated. | `cdc.go` shrinks to thin wrappers plus one hand-built object, `LastApplError` (§6.3). |
| **S5** | `LockDataModel` / `UpdateXAttributeValue` / `UnlockDataModel` batching | `Update(func(tx *Tx))` — atomic, drives reports on return | Direct mapping: one `Update` per drained batch (the C# batches up to 500 per lock). §9 |
| **S6** | DO-level FCDAs in data sets (`GGIO1$ST$Ind1` carries `stVal`+`q`+`t` as one structure) | **Fixed in v0.2.3.** `reporting.go:memberChanged` matches a member against the changed set in both directions: the member itself and every level above it, plus anything below it (with a trailing separator, so `Ind1` does not match a sibling `Ind1Extra`). Upstream ships `server/dofcda_test.go` covering exactly this, including the sibling trap. | **Data sets use DO-level FCDAs, exactly as the C# does.** §6.4. The sizing constants of the C# apply unchanged. |
| **S7** | `Timestamp.SetClockNotSynchronized(...)` | `mms.NewUTCTime(t, TimeQuality)` — the quality octet is a parameter | Build the octet ourselves: `mms.TimeClockNotSynchronized` when the source timestamp is missing or flagged not-OK, plus `mms.TimeAccuracy(10)`. Strictly more capable than the C#. §9.3 |
| **S8** | `ControlAddCause`, `CheckHandlerResult.OBJECT_ACCESS_DENIED` | `ControlHandler` returns `model.AddCause`; both phases arrive at one handler with `ctx.Select` | Direct mapping. §10 |
| **S9** | Client's peer address in `originatorIpAddress` | **Fixed.** `ControlCtx.Conn` and `ControlCtx.Peer` carry the association and its address; `Conn.Peer` is a `net.Addr` when the IP alone is wanted. | Use `ctx.Peer` verbatim — the same value the C# gets from `action.GetClientConnection().GetPeerAddress()`. §10 |
| **S10** | libiec61850 refuses responses larger than the negotiated PDU (`MMS_ERROR_RESOURCE_OTHER`) — the reason the C# model is split so aggressively | The Go stack does **not** enforce `LocalDetail` on responses; COTP segments the TSDU transparently | Keep the C# bounds anyway (§6.5): they protect *clients* with small PDUs, and keeping them means a client sees the same model shape from either driver. Noted, not exploited. |
| **S11** | `iedServer.IsRunning()` | No accessor | Track it ourselves (`serving atomic.Bool`, set around start/stop). Trivial. |

No gaps left. Everything this driver needs from the library is present, and the model it will serve is the C# driver's model.

---

## 3. Directory and module layout

```
src/iec61850/iec61850_server/
├── go.mod                  # module iec61850_server, go-iec61850 v0.2.3 + mongo-driver v2
├── go.sum
├── GO_DRIVER_PLAN.md       # this file
├── README.md               # user doc: parameters, model layout, sizing, deviations
├── AGENTS.md               # DOX file
├── main.go                 # ← Main.cs        : args, config, instance, connection, lifecycle
├── config.go               # ← Common_srv_cli.cs : documents, permissive BSON decode, mongo connect
├── log.go                  # copied from the Go client driver
├── points.go               # point selection query + the rtData projection the driver needs
├── model_builder.go        # ← ModelBuilder.cs : LD/LN/GGIO layout, sizing, data sets, RCBs
├── cdc.go                  # thin wrappers over model.NewDataObject + LastApplError
├── manifest.go             # ← ExportManifest  : log/iec61850_server_map_<conn>.json
├── server.go               # creation, identity, start/stop, connection events, allow-list,
│                           #   model properties, initial values
├── change_stream.go        # ← MongoChangeStream.cs : realtimeData watch + update queue
├── update_loop.go          # ← ServerUpdateLoop/ApplyUpdate/MapQuality : batched Tx updates
├── controls.go             # ← ControlHandlers.cs : control handler + commandsQueue inserter
├── redundancy.go           # ← Redundancy.cs : active/standby + stats
├── tlsconf.go              # server-side TLS (adapted from the client driver's)
├── selftest.go             # ← SelfTest.cs : synthetic model, no MongoDB
├── cdc_test.go             # model shape unit tests
├── model_builder_test.go   # layout, sizing, naming, data-set composition
├── update_loop_test.go     # quality mapping, value mapping per CDC
├── controls_test.go        # commandsQueue document shape
└── loopback_test.go        # server ⇄ go-iec61850 client: browse, report, GI, control, restart
```

Gone versus the v0.2.1 plan: `listener.go` (S1) and nearly all of `cdc.go` (S4).

`go.mod`:

```
module iec61850_server

go 1.26

require (
	github.com/dscsystems/go-iec61850 v0.2.3
	go.mongodb.org/mongo-driver/v2 v2.8.0
)
```

> Verify `go list -deps ./... | grep charm` is empty — the library's TUI dependencies must not be linked in.

---

## 4. Runtime contract (identical to the C#)

### 4.1 Command line

```
iec61850-server [instance [logLevel [configFile]]]
iec61850-server selftest [port [bulkPoints]]
```

* arg1 instance number (default 1), arg2 log level 0..3, arg3 config file — same resolution order as every driver: `args[2]` if it exists → `../conf/json-scada.json` → `c:/json-scada/conf/json-scada.json`, plus `JS_CONFIG_FILE`.
* `selftest` as the first argument runs §12.3 without MongoDB, as the C# does (`Main.cs:64`).
* Log level 3 additionally passes an `slog` debug logger to `server.New` (MMS PDU tracing).

### 4.2 Banner and exit conditions

```
[...] {json:scada} IEC61850 Server Driver (IEC61850-90-2, Go) - Copyright 2020-2026 Ricardo Olsen
[...] Driver version 0.1.0
[...] Using go-iec61850 version v0.2.3
[...] Log level: 1
[...] Reading config file ../conf/json-scada.json
[...] MongoDB database name: json_scada
[...] Node name: mainNode
[...] Connection: IEC61850SRV [8001]
[...] Bind address: 0.0.0.0:102
```

Exit `-1` with the C# message on: missing config file, empty `mongoConnectionString` / `mongoDatabaseName` / `nodeName`, instance disabled, node not in `nodeNames`, instance not found, and `No enabled connection found for this instance!`. Preserve the `break` after the first instance document and the `WARNING: more than one connection for this instance, using the first: <name>` line.

### 4.3 Shutdown

`signal.Notify(SIGINT, SIGTERM)` → log `Shutdown requested...`, stop the server, flush the log, exit 0 (the C# hooks `Console.CancelKeyPress`).

---

## 5. Configuration documents

`config.go`, permissive numeric decoding (`toFloat64` etc.) exactly as in the client driver.

### 5.1 `protocolConnections` — every parameter with the C# default

| Field | Type | Default | Use |
|---|---|---|---|
| `protocolDriver` | string | `""` | filter (`IEC61850_SERVER`) |
| `protocolDriverInstanceNumber` | double | 1 | filter |
| `protocolConnectionNumber` | double | 1 | loop prevention, manifest name, `originatorUserName`, `stats` key |
| `name` | string | `"NO NAME"` | sanitized to the **IED name** (≤20 chars) |
| `description` | string | `"SERVER NOT DESCRIPTED"` | documentation |
| `enabled` | bool | true | filter |
| `commandsEnabled` | bool | true | expose command points and accept controls |
| `ipAddressLocalBind` | string | `"0.0.0.0:102"` | bind address; port defaults to 102, or **3782** when `useSecurity` |
| `ipAddresses` | []string | — | optional client allow-list (empty = any) |
| `topics` | []string | — | `group1` values to expose (empty = all) |
| `serverModeMultiActive` | bool | true | when false, cap at 1 MMS client |
| `maxClientConnections` | double | 1 | `WithMaxConnections` **and** RCB copies per data set |
| `maxQueueSize` | double | 5000 | `WithReportBufferSize` (reports per buffered RCB) |
| `useSecurity` | bool | false | TLS |
| `localCertFilePath` / `privateKeyFilePath` / `rootCertFilePath` / `peerCertFilesPaths` / `chainValidation` / `allowOnlySpecificCertificates` / `allowTLSv10..13` / `cipherList` | | | IEC 62351-3, same semantics as the client driver's `tlsconf.go` |
| `username` / `password` | string | `""` | ACSE authentication (reserved in the C#; the Go server does not check it — deviation **E4**) |

### 5.2 Point selection (`points.go`) — the exact C# filter

```go
filter := bson.M{
    "_id":                            bson.M{"$gt": 0},
    "protocolSourceConnectionNumber": bson.M{"$ne": conn.ProtocolConnectionNumber}, // loop prevention
}
if len(conn.Topics) > 0 { filter["group1"] = bson.M{"$in": conn.Topics} }
if !conn.CommandsEnabled { filter["origin"] = bson.M{"$ne": "command"} }
```

Log `Points selected from realtimeData: N`, and `WARNING: no points matched the topics filter - server model will be empty.` when empty. Sort by `_id` when building (the C# does `OrderBy(p => (int)p._id)`) so object references are stable across restarts.

Fields read per point: `_id`, `tag`, `type`, `origin`, `group1`, `description`, `value`, `valueString`, `invalid`, `substituted`, `overflow`, `transient`, `timeTagAtSource`, `timeTagAtSourceOk`, and the command routing set `protocolSourceConnectionNumber`, `protocolSourceCommonAddress`, `protocolSourceObjectAddress`, `protocolSourceASDU`, `protocolSourceCommandDuration`, `protocolSourceCommandUseSBO`.

> The routing fields must keep the **BSON type they had in the source document** so the `commandsQueue` documents look exactly like the C#'s (and the OPC servers'). Decode them as `bson.RawValue` and re-emit verbatim rather than normalising.

---

## 6. The model builder

### 6.1 Naming

* IED name = `SanitizeMms(conn.name, 20)`, fallback `JSONSCADA`. `SanitizeMms`: non-alphanumeric → `_`, trim `_`, prefix `P` when empty or starting with a digit, and when longer than the limit truncate to `maxLen-5` plus `_` and the low 16 bits of an FNV-1a 32 hash in uppercase hex. Port verbatim — object references must match the C# for the same configuration.
* LD instance = `UniqueName(SanitizeMms(group1, 62-len(iedName)), used)`; `UniqueName` appends `_2`, `_3`, … on collision. `group1` empty → `GEN`.
* The full logical device name is `IEDName + ldInst` (`model.LogicalDevice.Name`), with `Inst = ldInst`.
* Oversized topics split into `KAW2`, `KAW2_2`, … each a separate LD; log `Topic 'X' has N points - split across M logical devices.`

### 6.2 Per logical device

| Node | Content |
|---|---|
| `LLN0` | `Beh` (ENS), `Health` (ENS), `NamPlt` (LPL), **`LastApplError`** (hand-built), the data sets, the report controls |
| `LPHD1` | `PhyNam` (DPL), `PhyHealth` (INS), `Proxy` (SPS) with `stVal = true` — the 90-2 gateway marker |
| `GGIO1..n` | `Beh` (ENS) plus the mapped points |

`LastApplError` is not in the C# model, but `server/control.go:setLastApplError` writes `AddCause` and `Error` into `LLN0.LastApplError` when a control is rejected, and the Go **client** driver reads `LLN0$ST$LastApplError$AddCause` to report the additional cause. Four attributes per LD make control rejections diagnosable end to end. The names must be exactly `AddCause` and `Error` (the library's spelling; the standard uses lower case — worth an upstream nit).

Point placement, ported from `MapPoint`:

* `digital` monitor → SPS `Ind`, `analog` monitor → MV `AnIn`, `string`/`json` monitor → VSS `Str`, `digital` command → SPC `SPCSO`, `analog` command → APC `AnOut`;
* a GGIO instance holds at most `MaxDataObjectsPerLN` **cost units**; a VSS point costs 8, everything else 1; when the next point does not fit, open `GGIO<n+1>` and reset the per-category counters, so every instance numbers its own objects from 1 (`GGIO1.Ind1..`, `GGIO2.Ind1..`);
* record the object reference per tag for the manifest and the control map.

### 6.3 Data objects (`cdc.go`) — now mostly one call each

```go
func newSPS(name string) *model.DataObject {           // digital monitor
    return model.NewDataObject(name, model.CDCSPS, model.WithOptional("d"))
}
func newMV(name string) *model.DataObject {            // analog monitor  → mag.f, q, t, d
    return model.NewDataObject(name, model.CDCMV, model.WithOptional("d"))
}
func newSPC(name string, sbo bool) *model.DataObject { // digital command → Oper/SBO(w)/Cancel, stVal, q, t, ctlModel, d
    m := model.CtlDirectNormal
    if sbo { m = model.CtlSBONormal }
    return model.NewDataObject(name, model.CDCSPC, model.WithOptional("d"), model.WithControlModel(m))
}
func newAPC(name string, sbo bool) *model.DataObject { // analog command  → ctlVal AnalogueValue, mxVal, q, t, ctlModel, d
    ...same with model.CDCAPC
}
func newENS(name string) *model.DataObject { return model.NewDataObject(name, model.CDCENS) }
func newINS(name string) *model.DataObject { return model.NewDataObject(name, model.CDCINS) }
func newLPL(name string) *model.DataObject { return model.NewDataObject(name, model.CDCLPL) }
func newDPL(name string) *model.DataObject { return model.NewDataObject(name, model.CDCDPL) }
```

`WithControlModel` produces exactly the structure the server decodes — `{ctlVal, origin{orCat, orIdent}, ctlNum, T, Test, Check}` — which is also what the C# built with `CDC_CTL_OPTION_ORIGIN|CDC_CTL_OPTION_CTL_NUM`, and it sets `ctlModel` to 1 (direct-normal) or 2 (SBO-normal) from `protocolSourceCommandUseSBO`, as `ControlOptions(p)` did. SBO-with-normal-security is fully implemented server-side (select by reading `$SBO`), so the C# mapping carries over unchanged.

String points are generated too, since v0.2.3:

```go
func newVSS(name string) *model.DataObject {            // string monitor -> stVal, q, t, d
    return model.NewDataObject(name, model.CDCVSS, model.WithOptional("d"))
}
```

One object is still ours: **LastApplError** — `cntrlObj` VisString129 ST, `Error` INT32 ST, `Origin` struct ST, `ctlNum` INT8U ST, `AddCause` INT32 ST. It is not a common data class, so there is nothing to generate it from.

`cdc_test.go` asserts, for every constructed object, that `model.Attribute(ref, fc)` resolves each documented leaf and that the value type matches — the same check whether the object came from the library or from us.

### 6.4 Data sets — DO-level FCDAs, as in the C#

Per LD, each monitored point contributes **one** FCDA naming the data object, so a report entry carries the whole `{stVal, q, t}` (or `{mag, q, t}`) structure — the form the C# driver emits and what a control centre expects:

| Point kind | FCDA (FC) | MMS form |
|---|---|---|
| SPS, VSS | `GGIOn.Ind1` (ST) | `GGIOn$ST$Ind1` |
| MV | `GGIOn.AnIn1` (MX) | `GGIOn$MX$AnIn1` |

Status-family FCDAs go to `DS_ST_k`, measurand-family to `DS_MX_k` — same split and names as the C#. Command points are **not** data-set members (they are outputs), matching `MapPoint`.

`model.DataSet{Name, Entries []model.FCDA{Ref, FC}}` on `LLN0`. The server exposes them as `LD/LLN0$DS_ST_1`, which is what the C# produced.

This works because `reporting.go:memberChanged` (v0.2.3) matches a member against the changed set in both directions: the member and its ancestors, plus anything below it. `Update` records the leaves it writes (`Ind1.stVal`, `Ind1.q`, `Ind1.t`), and each of them touches the member `Ind1`. The prefix test carries a trailing separator, so `Ind1` is not confused with a sibling named `Ind1Extra` — upstream's `server/dofcda_test.go` pins both halves.

### 6.5 Sizing bounds

The C# constants and derivation, unchanged — with DO-level FCDAs an entry count means what it means there. The bounds protect clients with small negotiated PDUs; the Go stack itself does not enforce a PDU limit (S10).

| Constant | Value | Meaning |
|---|---|---|
| `MaxDataObjectsPerLN` | 30 | cost units per GGIO instance (≈2.5 kB type description) |
| `DoCost(VSS)` | 8 | a string value can be far larger than a status or measurand |
| `MaxDescriptionLength` | 32 | `d` is published per object and one `[DC]` read returns them all |
| `EntriesPerDataSet` | 40 | one FCDA per point; reading a data set returns every member at once (~26 B/entry) |
| `MaxRcbPerLLN0` | 7 | `LLN0[BR]`/`[RP]` returns every control block of the family in one response |
| `MaxRcbCopiesPerDataSet` | 4 | one instance per concurrently reporting client, capped |

```
rcbCopies      = clamp(maxClientConnections, 1, MaxRcbCopiesPerDataSet)
dataSetBudget  = max(1, MaxRcbPerLLN0 / rcbCopies)
maxPointsPerLD = EntriesPerDataSet * max(1, dataSetBudget-1)

Model bounds: 2 RCB copies/data set, <= 80 points per logical device,
              <= 40 entries per data set, <= 30 objects per logical node
```

Plus the C#'s warning when `maxClientConnections > MaxRcbCopiesPerDataSet`.

### 6.6 Report control blocks

Per data set, one buffered and one unbuffered control, each with `RptEnabled = rcbCopies`:

```go
model.ReportControl{
    Name:         "brcbST01",            // + "01".."0N" appended by the server → brcbST0101, ...
    DataSet:      "DS_ST_1",             // plain name within the same LN
    ConfRev:      fnv32(join(memberRefs)),
    Buffered:     true,
    BufTime:      500,                   // ms, as in the C#
    TrgOps:       TrgDataChange|TrgQualityChange|TrgIntegrity|TrgGI,
    OptFlds:      OptSeqNum|OptTimeOfEntry|OptReasonCode|OptDataSetName|OptConfRev (+OptEntryID buffered),
    IntgPd:       0,
    RptEnabled:   rcbCopies,
    MaxQueueSize: int(conn.maxQueueSize), // buffered only; overrides the server default
}
```

Instance names come out as `brcbST0101`, `urcbST0101`, `brcbMX0101`, … — the names the C# creates explicitly. `RptID` is left empty so the server reports the RCB reference (deviation **E5**); set it to the C#'s literal only if a deployed client depends on it.

### 6.7 Manifest (`manifest.go`)

`log/iec61850_server_map_<protocolConnectionNumber>.json` (or the working directory when `../log` does not exist), an array of `{tag, pointKey, objectReference, cdc, isCommand}`, indented, logged as `Mapping manifest written: <path> (N points)`. Same shape as the C#; **sorted by `pointKey`** so the file is stable and diffable (deviation **E6**).

---

## 7. Server creation and lifecycle

```go
opts := []server.Option{
    server.WithIdentity(server.Identity{Vendor: "JSON-SCADA", Model: "IEC61850_SERVER", Revision: DriverVersion}),
    server.WithMaxConnections(maxConns),        // serverModeMultiActive ? maxClientConnections : 1
    server.WithReportBufferSize(int(conn.MaxQueueSize)),
}
if conn.UseSecurity { opts = append(opts, server.WithTLS(tlsCfg)) }
if LogLevel >= LogLevelDebug { opts = append(opts, server.WithLogger(dbg)) }
srv := server.New(mdl, opts...)

srv.OnConnection(func(ev server.ConnectionEvent) {
    switch ev.State {
    case server.ConnectionOpened:
        Log(1, "IEC61850 client connected: %s", ev.Peer)
        if !allowed(ev.Addr) {                    // conn.ipAddresses, port stripped
            Log(1, "Client %s not in allow-list, aborting connection.", ev.Peer)
            ev.Conn.Close()                       // = the C#'s con.Abort()
            return
        }
        openConns.Store(int32(ev.Open))
    case server.ConnectionClosed:
        Log(1, "IEC61850 client disconnected: %s", ev.Peer)
        openConns.Store(int32(ev.Open))
    case server.ConnectionRefused:
        Log(1, "Client %s refused: %d connections already open.", ev.Peer, srv.MaxConnections())
    }
})
```

`server.New` is called **once**, before any start/stop cycle (S3). The handler runs on the connection's goroutine and must not block or call `Update` — logging and a `Close()` are both safe.

Start/stop, driven by the redundancy state from the 1 Hz main loop:

```go
func startServer() {
    ln, err := net.Listen("tcp", bindAddr)      // tls.Listen when useSecurity
    if err != nil {
        Log(0, "ERROR: failed to start MMS server on %s (port in use or insufficient privileges for port < 1024?).", bindAddr)
        return                                   // retried on the next tick
    }
    go func() { _ = srv.Serve(ln) }()            // returns when Close() runs
    serving.Store(true)
    Log(0, "IEC 61850 MMS server STARTED on %s", bindAddr)
    applyModelProperties()   // proxy flags + descriptions, once
    applyInitialValues()     // snapshot of the DB into the model
}

func stopServer() {
    srv.Close(); serving.Store(false)
    Log(0, "IEC 61850 MMS server STOPPED (node inactive).")
}
```

`applyModelProperties` sets every `LPHD1.Proxy.stVal = true` and every `d` attribute (truncated at 32 chars, tag as fallback when the description is empty) inside one `Update`. `applyInitialValues` pushes the startup snapshot through the same path as live updates. The 1 Hz loop logs `Open MMS connections: N` when `srv.OpenConnections()` changes.

---

## 8. Redundancy

Port of `Redundancy.cs`, identical to the client driver's loop (5 s period, `countKeepAliveUpdatesLimit = 4`, random 1–5 s pause on deactivation, `Node '<x>' not found in instances configuration!` → exit), with two server specifics:

* the **active flag drives the MMS server**: the 1 Hz main loop starts it when active and stops it when not, so a standby never serves stale data;
* the `stats` document carries the server view:

```go
bson.M{"stats": bson.M{
    "nodeName":        cfg.NodeName,
    "timeTag":         now,
    "isRunning":       serving.Load(),
    "openConnections": srv.OpenConnections(),
    "pointsExposed":   len(mapByTag),
}}
```

Match the field names `Redundancy.cs:110+` writes when implementing.

---

## 9. Data path: change stream → model

### 9.1 Watch (`change_stream.go`)

Same pipeline as the C# `BuildCsFilter`, which is also the OPC servers' filter:

```
{ $or: [
    { $and: [
        { fullDocument.group1: { $in: [topics...] } },          // only when topics is non-empty
        { updateDescription.updatedFields.sourceDataUpdate: { $exists: false } },
        { fullDocument._id: { $gt: 0 } },
        { operationType: 'update' } ] },
    { operationType: 'replace' } ] }
```

with `fullDocument: updateLookup`. Skipping documents whose update touched `sourceDataUpdate` is deliberate: those are the raw protocol writes, and `cs_data_processor` follows them with the processed `value`/quality update this driver wants.

Per event: ignore anything but update/replace, look the tag up in `mapByTag`, skip command points, build a `PointUpdate`, enqueue. `invalid` defaults to **true** when absent. On error: log `Exception MongoCS`, sleep 3 s, re-open.

### 9.2 Update loop (`update_loop.go`)

```go
for !shutdown {
    if !serving.Load() { sleep(100ms); continue }
    upd, ok := dequeue(); if !ok { sleep(20ms); continue }
    srv.Update(func(tx *server.Tx) {
        n := 0
        for {
            applyUpdate(tx, upd)
            if n++; n >= 500 { break }
            if upd, ok = dequeue(); !ok { break }
        }
    })
}
```

One `Update` per batch of up to 500 — the equivalent of the C#'s single `LockDataModel` around 500 applications, and it means one report per batch rather than one per point.

### 9.3 `applyUpdate` — order matters

Timestamp first, then quality, then value (the C# order: the value write is the trigger, so quality and timestamp are already in place when the report fires):

```go
tx.Set(ref.Child("t"), fc, mms.NewUTCTime(ts, tq))   // tq: TimeAccuracy(10) | ClockNotSynchronized when
                                                     // there is no source time or it is flagged not OK
tx.Set(ref.Child("q"), fc, mapQuality(upd).Value())
switch kind {
case SPS, SPC: tx.Set(valueRef, ST, mms.NewBool(v != 0))
case MV:       tx.Set(ref.Child("mag").Child("f"), MX, mms.NewFloat32(float32(v)))
case APC:      tx.Set(ref.Child("mxVal").Child("f"), MX, mms.NewFloat32(float32(v)))
case INS, INC: tx.Set(valueRef, fc, mms.NewInt32(int32(v)))
case VSS:      tx.Set(valueRef, ST, mms.NewVisibleString(valueString))
}
```

`mapQuality` is a literal port of `MapQuality`:

```
invalid                     → Validity INVALID
else overflow || transient  → Validity QUESTIONABLE, + Overflow bit, + Oscillatory bit
else                        → Validity GOOD
substituted                 → Substituted bit
test                        → Test bit
```

using `model.Quality`, `WithValidity` and the `QualityOverflow` / `QualityOscillatory` / `QualitySubstituted` / `QualityTest` flags. Unit-tested against the bit patterns the C# `Quality.Value` produces.

---

## 10. Controls → `commandsQueue`

`OnControl` is registered for every command point when `commandsEnabled` (the C# installs a check handler and a control handler; the library funnels both phases into one):

```go
srv.OnControl(model.ObjectReference(mp.objRef), func(ctx *server.ControlCtx) model.AddCause {
    if !conn.CommandsEnabled || !active.Load() { return model.AddCauseBlockedByMode }
    if ctx.Select { return model.AddCauseNone }        // accept the reservation, queue nothing
    v, s, err := ctlValue(mp.kind, ctx.Value)          // SPC: bool→1/0/"true"/"false"; APC: float; INC: int
    if err != nil { return model.AddCauseInconsistentParameters }
    queueCommand(mp, v, s, ctx.Peer)                   // S9: the observed peer, not a claim
    return model.AddCauseNone
})
```

The select phase must be accepted but must **not** insert a command — the C# only queues from the control handler, which libiec61850 calls on operate.

Document inserted (field-for-field the C#'s, which is also the OPC servers'):

```go
bson.M{
    "protocolSourceConnectionNumber": mp.srcConnNumber,           // double
    "protocolSourceCommonAddress":    mp.srcCommonAddress,        // original BSON type
    "protocolSourceObjectAddress":    mp.srcObjectAddress,        // original BSON type
    "protocolSourceASDU":             mp.srcASDU,                 // original BSON type
    "protocolSourceCommandDuration":  mp.srcCommandDuration,      // double
    "protocolSourceCommandUseSBO":    mp.srcCommandUseSBO,        // bool
    "pointKey":                       mp.pointKey,                // int
    "tag":                            mp.tag,
    "value":                          doubleVal,
    "valueString":                    strVal,
    "originatorUserName":             fmt.Sprintf("IEC61850 connection: %d %s", conn.Number, conn.Name),
    "originatorIpAddress":            ctx.Peer,
    "timeTag":                        time.Now().UTC(),
}
```

Insertion happens on a background goroutine draining a queue, so the MMS handler never blocks on MongoDB; on insert error, log and retry after 1 s. Log `Command queued: <tag> = <value> (from <peer>)`.

---

## 11. Logging parity

Preserve these lines (operators grep them): `IED name: X`, `Model bounds: ...`, `Topic 'X' has N points - split across M logical devices.`, `Model built: N logical device(s), P point(s), C command(s).`, `Mapping manifest written: ...`, `IedServer created (...)`, `IEC 61850 MMS server STARTED/STOPPED ...`, `Applied model properties (proxy flags: N, descriptions: M).`, `Initial values loaded into the model.`, `Installed control handlers for N command point(s).`, `Open MMS connections: N`, `IEC61850 client connected/disconnected: <peer>`, `Points selected from realtimeData: N`.

---

## 12. Testing

### 12.1 Unit (no network, no MongoDB)

* `cdc_test.go` — every constructor: attribute names, FCs, kinds, defaults, trigger options; `model.Attribute` resolves each leaf; an `Oper` structure has exactly the six members `decodeOper` indexes; the hand-built LastApplError matches the library's conventions.
* `model_builder_test.go` — GGIO packing (30 cost units, VSS costs 8, per-instance renumbering), LD splitting, `SanitizeMms`/`UniqueName`/`Fnv32` against the C# outputs for a table of names, data-set composition (one DO-level FCDA per monitored point, commands excluded), RCB naming/count/`MaxQueueSize`, `confRev` stability.
* `update_loop_test.go` — `mapQuality` truth table; per-CDC value placement; the timestamp quality octet with and without a source time.
* `controls_test.go` — the `commandsQueue` document: every field present, `value`/`valueString` per CDC, routing fields keeping their original BSON types, `originatorUserName` format, `originatorIpAddress` taken from `ctx.Peer`.

### 12.2 Loopback (in-process, no MongoDB)

`loopback_test.go` builds a model from synthetic points, starts the server on `127.0.0.1:0` and drives it with the library's **client** package:

1. browse: the expected LDs, `LLN0`/`LPHD1`/`GGIOn`, and `LPHD1.Proxy.stVal == true`;
2. read: a monitored point's value, quality and timestamp after an update;
3. data set: `ReadDataSet` returns the expected members in order;
4. reporting: enable a URCB, push an update, receive a data-change report whose entry is the whole `{stVal, q, t}` structure with `ReasonDataChange`, and assert that a sibling whose name extends another's (`Ind1` / `Ind1Extra`) is not dragged in;
5. GI: `TriggerGI` returns every member with `ReasonGI`;
6. buffered reports: enable a BRCB, disconnect, push updates, reconnect with `ResyncEntryID` and receive the buffered ones; a small `MaxQueueSize` drops the oldest and raises `BufOvfl`;
7. **restart**: `Close()` then serve again on a new listener, and a client reconnects and browses — the S3 assumption;
8. controls: a direct-normal `SPCSO` operate produces the expected queued command with the right peer; an SBO-normal point requires the `$SBO` read first and rejects an operate without it; a rejected control (commands disabled) surfaces `AddCauseBlockedByMode` and populates `LastApplError`;
9. connections: a client outside the allow-list is closed on connect; the `WithMaxConnections` cap produces a `ConnectionRefused` event and the client sees the transport drop.

### 12.3 `selftest` mode

Port `SelfTest.cs`: synthetic points covering every CDC, optional `bulkPoints` argument to stress the layout, model build, manifest export, server start on a chosen port (default 10102), a few simulated updates through the normal path, then hold the server up for manual browsing. Prints `SELF TEST: ...` lines and exits non-zero on failure.

### 12.4 End-to-end with MongoDB and the Go client driver

The C# README's loopback recipe, unchanged:

```bash
mongosh json_scada --eval 'db.protocolConnections.insertOne({protocolDriver:"IEC61850_SERVER",protocolDriverInstanceNumber:1,protocolConnectionNumber:8001,name:"IEC61850SRV",enabled:true,commandsEnabled:true,ipAddressLocalBind:"0.0.0.0:10102",topics:["KAW2"],serverModeMultiActive:true,maxClientConnections:4,maxQueueSize:5000,useSecurity:false})'
```

then an `IEC61850` client connection (different number) pointing at `127.0.0.1:10102` with `autoCreateTags: true`, and both drivers running. Expected: the client mirrors the KAW2 points within ~1 s, and operating a `SPCSO` from the client produces a `commandsQueue` document carrying the *original* source point's routing fields.

### 12.5 Interop

Against the C# driver: run both against the same database and topic, browse each with the same client, and diff the object references, data-set membership and RCB names. They must match exactly — object references, data-set membership and RCB names alike. Also run the library's own suite once at the pinned version (`go test github.com/dscsystems/go-iec61850/...`) and record it.

---

## 13. System integration checklist

| # | File | Change |
|---|---|---|
| 1 | `platform-linux/build.sh` | after the client block: `cd ../iec61850_server && go mod tidy && go build -o ../../../bin/iec61850-server` (restore the cwd afterwards, as the client block does) |
| 2 | `platform-windows/build.bat`, `buildupd.bat` | `cd %SRCPATH%\iec61850\iec61850_server` + `go build -ldflags="-s -w" -o %BINPATH%\iec61850-server.exe` |
| 3 | `platform-{rhel9,rhel10,ubuntu-2404,ubuntu-2604}/` | new `iec61850goserver.ini` (`[program:iec61850goserver]`, `autostart=false`, `command=.../bin/iec61850-server 1 1`, log `iec61850goserver.log`) |
| 4 | `platform-windows/create_services.bat` | commented nssm block `JSON_SCADA_iec61850goserver` with the *either/or* note; matching lines in `remove_services.bat`, `start_protocols.bat`, `stop_protocols.bat`, `restart_protocols.bat` |
| 5 | `Dockerfile` | build stage for the new binary |
| 6 | `conf-templates/log.io-file.json` | `iec61850goserver.log` stream |
| 7 | `driver-catalog.js` | **no change by default**; document the one-line switch (`exe: '{bin}/iec61850-server'`) |
| 8 | AdminUI | **no change** — `IEC61850_SERVER` is already wired |
| 9 | `README.md`, `index.md`, `AGENTS.md`, `src/AGENTS.md`, `.agents/skills/protocol-driver-development/SKILL.md` | list the Go server next to the C# one |
| 10 | `platform-windows/release_notes.txt` | mention it |
| 11 | new `README.md` + `AGENTS.md` in the driver directory | parameters, model layout, sizing, deviations, port-102 privileges (`setcap 'cap_net_bind_service=+ep'`) |

---

## 14. Work breakdown

| Phase | Deliverable | Depends on |
|---|---|---|
| **P0** | `go.mod`, `log.go` (from the client driver), `config.go`, `points.go`, `main.go` skeleton with the exit conditions and banner | — |
| **P1** | `cdc.go` + `cdc_test.go` — the wrappers plus LastApplError | P0 |
| **P2** | `model_builder.go` + `model_builder_test.go` — layout, bounds, data sets, RCBs; `manifest.go` | P1 |
| **P3** | `server.go` — creation, identity, connection events and allow-list, start/stop, model properties, initial values | P2 |
| **P4** | `change_stream.go` + `update_loop.go` — the live data path | P3 |
| **P5** | `controls.go` — control handler and the command inserter | P3 |
| **P6** | `redundancy.go` — active/standby + stats | P4 |
| **P7** | `tlsconf.go` (adapt the client driver's) + a TLS loopback case | P3 |
| **P8** | `loopback_test.go` — the nine cases of §12.2 | P4, P5 |
| **P9** | `selftest.go` and a manual browse with `iedx` / IEDExplorer | P8 |
| **P10** | Interop diff against the C# driver (§12.5), integration (§13), README/AGENTS | P9 |

A demonstrable slice exists at the end of **P4**: a server a client can browse and receive reports from, without commands or redundancy. P1 and P3 are a fraction of what they were before v0.2.2, and §6.4 no longer carries a compromise.

---

## 15. Deviations from the C# driver (each must be in the README)

| ID | Deviation | Reason |
|---|---|---|
| **E2** | `maxQueueSize` is a count of **reports** per buffered control block, not a byte budget | The C# converts it to bytes at ~128 B/entry for libiec61850; the library counts reports. The configured number is used directly, and the effective depth is logged. |
| **E4** | `password` (ACSE authentication) is accepted in the configuration but not enforced | The Go server does not check ACSE authentication values. |
| **E5** | Each report control block instance is given an `RptID` equal to its own object reference | That is the default IEC 61850-8-1 prescribes and what libiec61850 sends. The library composes the default from the *configured* block name, not the materialised instance name, so all instances of `brcbMX01` would report `LD/LLN0$BR$brcbMX01` — a block that does not exist, and the same identifier for every instance. `fixReportIDs` in `server.go` rewrites them after materialisation; remove it once the library fixes `rcbRptID`. |
| **E6** | The mapping manifest is sorted by `pointKey` | The C# writes map-iteration order, which is unstable between runs. |
| **E8** | Terminates on SIGINT/SIGTERM | Services have no console. |
| **E9** | Banner names go-iec61850 | It is not libiec61850. |

Retired by v0.2.2: the peer-address guess (was E3 — `ControlCtx.Peer` is now exact), the fixed buffer depth (was part of E2), and the pre-association rejection of allow-listed clients (was E7 — the driver now closes the association exactly as the C# does).
Retired by v0.2.3: the DA-level data sets (was E1 — DO-level FCDAs now trigger correctly) and the hand-built string object (was E10 — `CDCVSS` is generated).

**What remains are six deviations, none of which a client can see**: a unit change on a buffer setting, an unenforced password, an empty `RptID`, a sorted manifest, a signal handler and a banner line.

Reproduced on purpose (the C# behaviour, kept so both drivers present the same gateway):

* the **model is static** — points added later are not exposed until a restart (log a warning when a matching insert is seen);
* one logical device per topic with the same splitting rule, the same GGIO packing and numbering, the same `Ind`/`AnIn`/`Str`/`SPCSO`/`AnOut` prefixes and therefore the **same object references**;
* the same sizing constants, so clients see the same model shape;
* descriptions truncated to 32 characters, with the full text only in the manifest;
* `invalid` treated as true when the field is missing;
* command points excluded from data sets and never updated from the database.

---

## 16. Risks and open items

1. **Model size.** The bounds keep responses small, but a large database still produces many logical devices (80 points/LD at `maxClientConnections=2`). Watch the LD count on a real database and consider raising `MaxRcbPerLLN0` now that the Go stack does not enforce a PDU ceiling (S10) — measure against the actual clients first.
2. **Start/stop cycling (S3)** is assumed safe; if `Serve` after `Close` leaves report state behind, the fallback is to rebuild the model and the server on each activation, which costs a few hundred milliseconds and is invisible to clients.
3. **go-iec61850 is pre-v1.** v0.2.2 changed `materialiseRCBs` and `ControlCtx`, v0.2.3 changed report member matching and added a data class — all additive for us, but pin the exact version in `go.mod`, never `@latest` in build scripts, and re-run §12.1–§12.5 on any bump. The client driver in `../iec61850_client` is pinned to the same v0.2.3; keep them together when either moves.
4. **`selectTimeout` is 30 s** in the library and not configurable; libiec61850's default is also 30 s, so no action.
5. **Port 102** needs `cap_net_bind_service` on Linux or a port above 1024; unchanged from the C#.
6. **Open question:** should the Go server expose `INS`/`INC` (integer) points? The C# defines the kinds but never maps to them. Keep the constructors, leave the mapping identical, revisit if an integer point type is added to the schema.
