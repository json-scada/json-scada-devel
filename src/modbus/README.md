# Modbus Client & Server Drivers

Native TypeScript/Node.js Modbus drivers for {json:scada}. Two independent driver
processes share one package:

- **`MODBUS`** — client/master. Polls devices, updates `realtimeData`, dispatches
  commands. See [README-client.md](README-client.md).
- **`MODBUS_SERVER`** — server/slave. Exposes tags to third-party masters and relays
  their writes as JSON-SCADA commands. See [README-server.md](README-server.md).

## Supported transports

| Mode (client) | Mode (server) | Framing | Default port |
|---|---|---|---|
| `TCP Active` | `TCP Passive` | MBAP over TCP | 502 |
| `TLS Active` | `TLS Passive` | MBAP over TLS (Modbus Security) | 802 |
| `Serial` | `Serial` | RTU over RS-232/RS-485 | — |
| `RTU over TCP` | `RTU over TCP Passive` | RTU frame over TCP | 502 |
| `RTU over TLS` | `RTU over TLS Passive` | RTU frame over TLS | 802 |

## Byte orders (non-standard register representations)

Every multi-register value can be decoded/encoded with **any** byte order. On the wire,
registers are always 16-bit big-endian words in ascending order; the driver reorders the
raw bytes per a byte-order spec before decoding as big-endian, so all permutations are
expressible.

Specify the byte order as a suffix on the ASDU: `float32_cdab`, `int32_le`,
`uint64_ghefcdab`, `string:16_ba`. Named aliases per width:

| Alias | 16-bit | 32-bit | 64-bit | Meaning |
|---|---|---|---|---|
| `BE` (default) | `AB` | `ABCD` | `ABCDEFGH` | Modbus standard big-endian |
| `LE` | `BA` | `DCBA` | `HGFEDCBA` | full little-endian |
| `SW` | — | `CDAB` | `GHEFCDAB` | word-swapped |
| `SB` | — | `BADC` | `BADCFEHG` | byte-swapped |

Or give an **explicit permutation string** of the value's bytes — `CDAB`, `BADC`,
`GHEFCDAB`, `BADCFEHG`, or any other permutation of the first N letters (N = value width
in bytes). This covers all 2!/4!/8! orderings. `BIG_ENDIAN`/`LITTLE_ENDIAN`/`REV_ENDIAN`
are accepted as synonyms of `BE`/`LE`/`LE` for migration from the PLC4X driver.

Connection-level defaults (`byteOrder16`, `byteOrder32`, `byteOrder64`, `byteOrderStr`)
apply when a tag's ASDU omits the order.

## Value types

`bool`, `int16`/`uint16`, `int32`/`uint32`, `int64`/`uint64`, `float32`/`float64`,
`bcd16`/`bcd32`, `bitstring16`, `string:<bytes>`. IEC 754 NaN/Inf are flagged
`invalidAtSource`. A `.b<n>` suffix on a holding/input register address extracts a single
bit (supervision) or writes one via FC22 / read-modify-write (command).

## Addressing

`protocolSourceObjectAddress` (client) / `protocolDestinationObjectAddress` (server):

```
<area>:<offset>[.b<bit>]
```

`area` = `co` (coils, FC1/5/15), `di` (discrete inputs, FC2), `hr` (holding, FC3/6/16/22),
`ir` (input registers, FC4). `offset` is the **0-based PDU address**. Classic 1-based
Modicon references map as `40001`⇔`hr:0`, `30011`⇔`ir:10`, `10005`⇔`di:4`, `00001`⇔`co:0`;
set `useModiconAddresses: true` on the connection to enter them directly. PLC4X-style
aliases (`holding-register:4`, `coil:1`) are also accepted.

`protocolSourceCommonAddress` / `protocolDestinationCommonAddress` = the Modbus **unit id**
(slave address, 0–255; 0 = broadcast, write-only). One connection can address many unit
ids (multi-drop RTU or a gateway fan-out).

## Build & test

```bash
npm install
npm run build          # tsc -> dist/
npm test               # unit + loopback tests
npm run dev:client     # tsx src/client/main.ts <instance> <logLevel> <configFile>
npm run dev:server     # tsx src/server/main.ts <instance> <logLevel> <configFile>
```

Run built:

```bash
node dist/client/main.js 1 1 ../../conf/json-scada.json
node dist/server/main.js 1 1 ../../conf/json-scada.json
```

Command-line args: `<instance number> <log level 0-3> <config file path>`.
Environment overrides: `JS_MODBUS_*` (client), `JS_MODBUSSRV_*` (server) with suffixes
`INSTANCE`, `LOGLEVEL`, `CONFIG_FILE`.

## Logging

The log level is the driver's 2nd command-line argument (or `JS_MODBUS_LOGLEVEL` /
`JS_MODBUSSRV_LOGLEVEL`).

| Level | What is logged |
|---|---|
| 0 | minimum |
| 1 | connection state, command results, and **protocol/request errors** (server exceptions, refused writes, failed command inserts) |
| 2 | + per-block read failures, client connect/disconnect, tag/point map summaries |
| 3 | + full low-level protocol trace |

At level 3 every frame is traced in both directions, with the decoded PDU and the raw
ADU/PDU hex, plus poll-cycle timing, per-tag decoded values, retries, timeouts,
unmatched responses, and framing desynchronization:

```
PLC_AREA_51: TX unit=1 txn=1 fc=3 READ_HOLDING_REGISTERS addr=0 qty=2 | ADU: 00 01 00 00 00 06 01 03 00 00 00 02
PLC_AREA_51: RX unit=1 fc=3 READ_HOLDING_REGISTERS bytes=4 | PDU: 03 04 04 D2 00 00
PLC_AREA_51:   PLC1_FLOW [hr:0 float32_cdab] = 12.34
```

Server request errors are reported at level 1, so they are visible without enabling
tracing — each names the client, the decoded request, and the exception returned:

```
MODBUS_SRV_1: [192.168.0.50:49812] request error: unit=1 fc=3 READ_HOLDING_REGISTERS addr=100 qty=2 -> exception 0x02 ILLEGAL DATA ADDRESS
MODBUS_SRV_1: write from 192.168.0.50:49812 to KAW2_CB1_CMD refused: commands are disabled for this connection
```

## Architecture

`src/core/` is a transport-agnostic Modbus engine with no MongoDB or JSON-SCADA imports
(CRC16, PDU builders/parsers, MBAP + RTU framing, the byte-order codec, and the client
and server stacks). `src/common/` ports the shared JSON-SCADA scaffolding (logger,
config loader, redundancy). `src/client/` and `src/server/` contain the two drivers. Only
serial support pulls in a native module (`serialport`), imported lazily so TCP/TLS-only
deployments never load it.

## Limitations

Modbus has no source timestamps or quality flags: supervised values carry
`timeTagAtSourceOk: false`, and validity is inferred from communication status. The
server has no way to convey "invalid" to a master — configure `invalidValuePolicy`
(`last`/`zero`) to choose behavior. RTU framing uses length-prediction plus a CRC and an
idle-gap fallback rather than strict T3.5 character timing (not achievable in Node.js);
tune `interFrameDelayMs` for unusual devices.
