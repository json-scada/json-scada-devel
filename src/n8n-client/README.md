# N8N Integration Driver

Bidirectional integration between [JSON-SCADA](https://github.com/riclolsen/json-scada)
and the [n8n](https://n8n.io) workflow-automation platform.

- **Outbound (SCADA → n8n)**: tails MongoDB change streams (processed value changes on
  `realtimeData`, and optionally `soeData` events) and POSTs batched JSON envelopes to one
  or more n8n **Webhook** URLs.
- **Inbound (n8n → SCADA)**: runs an HTTP listener where n8n workflows push values
  (creating/updating supervised tags owned by this connection, like the telegraf-listener)
  and — with an explicit double opt-in — issue commands.

Operator-style supervision from n8n (commands with RBAC, alarm/event acknowledgement,
history reads) should instead go through `server_realtime_auth`'s `/Invoke` API using the
companion **`n8n-nodes-jsonscada`** community node package — that path enforces per-role
rights and writes `userActions` audit records. The driver's direct command endpoint exists
only for headless/NOAUTH deployments and is disabled by default.

This driver is named `N8N` and is registered like any other JSON-SCADA protocol driver
(one connection per driver instance; run multiple instances for multiple connections).

## Command line

```
node index.js [instanceNumber] [logLevel] [configFile]
```

| Arg | Default |
|-----|---------|
| instanceNumber | `1` (or `JS_N8N_INSTANCE`) |
| logLevel | `1` (or `JS_N8N_LOGLEVEL`; 0=min,1=normal,2=detailed,3=debug) |
| configFile | `../../conf/json-scada.json` (or `JS_CONFIG_FILE`) |

Environment overrides:

| Var | Purpose |
|-----|---------|
| `JS_N8N_INSTANCE` | instance number |
| `JS_N8N_LOGLEVEL` | log level |
| `JS_N8N_BIND_ADDRESS` | inbound listener bind address (overrides connection) |
| `JS_N8N_BIND_PORT` | inbound listener bind port (default `51930`) |
| `JS_CONFIG_FILE` | path to `json-scada.json` |

## Connection configuration

Create one `protocolConnections` document with `protocolDriver: "N8N"` (via the AdminUI
Protocol Connections tab). The driver reuses existing connection fields:

| Field | Meaning for N8N |
|-------|-----------------|
| `endpointURLs` | n8n Webhook URLs to POST outbound notifications to (fan-out to all). |
| `topics` | Outbound filter list (see grammar below). Empty = all value changes, no SOE. |
| `passphrase` | Outbound auth: sent as `Authorization: Bearer <passphrase>` (n8n Webhook "Header Auth"). Empty = no header. |
| `ipAddressLocalBind` | Inbound listener bind, e.g. `0.0.0.0:51930`. |
| `ipAddresses` | Allowed inbound source IPs (empty = any). |
| `username` / `password` | Basic-auth credentials n8n must present on inbound calls. **No username ⇒ all inbound data/command calls are refused.** |
| `autoCreateTags` | Auto-create unknown tags on inbound `/n8n/updates`. |
| `commandsEnabled` | Prerequisite for the direct command endpoint (see `options.enableDirectCommands`). |
| `timeoutMs` | Outbound HTTP timeout (ms). |
| `giInterval` | Integrity full-snapshot push interval (seconds). `0` = disabled. |
| `deadBand` | Numeric dead-band for outbound analog change notifications. |
| `maxQueueSize` | Per-URL outbound buffer cap while n8n is unreachable (drop-oldest beyond cap). |
| `localCertFilePath` / `privateKeyFilePath` | Enable HTTPS on the inbound listener. |
| `rootCertFilePath` | CA for inbound client certs and/or outbound HTTPS CA pinning. |
| `chainValidation` | When true, outbound HTTPS validates the server certificate chain. |
| `options` | JSON string of extra settings (see below). |
| `stats` | Maintained by the driver (see Observability). |

### `options` JSON

```json
{
  "batchMaxSize": 50,
  "batchWaitMs": 500,
  "retryMaxMs": 60000,
  "heartbeatMs": 60000,
  "notifyValueChanges": true,
  "notifySoe": true,
  "enableDirectCommands": false
}
```

- `batchMaxSize` / `batchWaitMs` — outbound batch flush thresholds.
- `retryMaxMs` — cap for exponential backoff on webhook delivery failure.
- `heartbeatMs` — low-frequency `heartbeat` envelope so workflows can detect a dead link
  (`0` disables).
- `notifyValueChanges` / `notifySoe` — enable/disable each outbound stream.
- `enableDirectCommands` — **double opt-in** for the inbound `/n8n/commands` endpoint
  (also requires `commandsEnabled: true`).

### Outbound filter grammar (`topics`)

Value-change selectors (any match includes the point):

| Entry | Effect |
|-------|--------|
| `group1:<name>` | match `group1` exactly |
| `group2:<name>` | match `group2` exactly |
| `tag:<name>` | match `tag` exactly |
| `tagprefix:<prefix>` | match tags starting with `<prefix>` |
| `<name>` | shorthand for `group1:<name>` |

SOE (event) selectors (must be opted in explicitly):

| Entry | Effect |
|-------|--------|
| `soe:all` | forward all SOE events |
| `soe:priority<=<n>` | forward SOE events with priority ≤ n |
| `soe:group1:<name>` | forward SOE events for a group1 |

When every value rule is `group1:`-based the change-stream match is narrowed server-side;
otherwise filtering is applied client-side.

## Outbound payload

```json
{
  "schema": "jsonscada-n8n/1",
  "type": "valueChange",
  "nodeName": "mainNode",
  "connectionNumber": 3001,
  "connectionName": "N8N-MAIN",
  "timestamp": "2026-07-04T12:00:00.000Z",
  "points": [
    {
      "tag": "KAW2AL-21MTWT", "pointKey": 3245,
      "value": 12.34, "valueString": "12.34", "valueJson": null,
      "type": "analog", "invalid": false, "substituted": false, "alarmed": false,
      "timeTag": "…", "timeTagAtSource": "…",
      "group1": "KAW2", "group2": "TRAFO-1", "description": "Active Power", "unit": "MW"
    }
  ]
}
```

`type` is one of `valueChange`, `soeEvent` (carries `events: [...]`), `integrity`
(full snapshot, same point shape) or `heartbeat`.

## Inbound HTTP API

Base bind: `ipAddressLocalBind` (default `0.0.0.0:51930`). Basic auth required
(`username`/`password`) except `/n8n/health`.

### `POST /n8n/updates`

```json
{ "points": [ { "tag": "N8N-CALC-1", "value": 42.5, "invalid": false, "timeTagAtSource": "2026-07-04T12:00:00Z" } ] }
```

Updates the `sourceDataUpdate` of tags owned by this connection; unknown tags are
auto-created when `autoCreateTags` is set (number→analog, boolean→digital, string→string,
object→json). Response: `{ "updated": n, "created": m, "errors": [...] }`.

### `POST /n8n/commands` (optional, double opt-in)

```json
{ "tag": "KAW2KPR21XCBR-CMD", "value": 1 }
```

Requires `commandsEnabled: true` **and** `options.enableDirectCommands: true`. Validates the
target is a command point (`origin == "command"`), inserts a `commandsQueue` document
(`originatorUserName: "N8N:<connection>"`) and writes a `userActions` audit entry.
Disabled → `403`. **Prefer the `/Invoke` path (n8n-nodes-jsonscada) for supervised commands.**

### `GET /n8n/health`

Public liveness + stats JSON (used by installer smoke tests).

## Observability

`protocolConnections.stats` is updated every 10 s with:
`{ nodeName, timeTag, notificationsSent, notificationsDropped, webhookErrors, lastWebhookError, inboundUpdates, inboundCommands, queueSizes }`.
Logs go to stdout (picked up by log.io / logrotate).

## Redundancy

Standard JSON-SCADA driver redundancy: only the active node (per `protocolDriverInstances`
keep-alive election) opens change streams / pushes / accepts inbound writes.

## Testing

```
npm install
npm test          # runs test/self-test.js (no MongoDB needed)
```

The self-test covers filter parsing, tag type inference/creation, live outbound webhook
delivery (with bearer auth + batching) and the inbound listener (auth gating, auto-create,
command opt-in, health).

For a full end-to-end test use the demo stack (`demo-docker`) plus a stub or real n8n
instance — see [docs/n8n-integration.md](../../docs/n8n-integration.md).

## No-code quick paths

- **n8n → SCADA now**: n8n HTTP Request node → `POST /login` then `POST /Invoke`.
- **SCADA → n8n now**: MQTT-Sparkplug-B driver + n8n MQTT Trigger node.
- **Direct DB**: n8n MongoDB node against a read-only `realtimeData` user.
