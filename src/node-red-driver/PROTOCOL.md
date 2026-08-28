# Node-RED Driver WebSocket Protocol — v1

This is the normative wire contract between the `NODE-RED` JSON-SCADA driver
(WebSocket **server**) and any client (the `node-red-contrib-jsonscada` palette, or
plain Node-RED `websocket` nodes). The driver advertises `protocolVersion` in its
`helloAck`; a client that requires a different major version must refuse to operate.

- Transport: WebSocket (`ws://` or, when the connection has TLS certs, `wss://`).
- Framing: one UTF-8 JSON object per text frame.
- Every message has a `type` string field.
- Default endpoint: `ws://<host>:51931` (configurable via `ipAddressLocalBind`).

## Session establishment

The first frame a client sends **must** be `hello`. Until the driver replies with
`helloAck`, only `hello` is accepted; anything else gets `{"type":"error","code":"unauth"}`.

Client → driver:

```json
{ "type": "hello", "token": "shared-secret", "clientId": "my-flow", "protocolVersion": 1 }
```

- `token` — compared (constant-time) against the connection's `password`. If the
  connection has an empty password, any token (or none) is accepted.
- On auth failure the driver replies `{"type":"error","code":"auth"}` and closes with
  code `4401`.

Driver → client:

```json
{ "type": "helloAck", "connectionNumber": 9100, "connectionName": "NODERED1",
  "protocolVersion": 1, "serverVersion": "0.1.0" }
```

## Subscription

Client → driver — replaces the client's current subscription:

```json
{ "type": "subscribe", "all": false, "tags": ["KAW2AL-21LT7"], "topics": ["KAW2"],
  "commands": true, "snapshot": true }
```

- `all` — receive every published tag (subject to the connection `topics` filter).
- `tags` — exact tag names to receive.
- `topics` — `group1` values to receive.
- `commands` — also receive operator commands for this connection (see below).
- `snapshot` — if not `false`, the driver immediately sends a `snapshot` of the current
  values of the matching tags (integrity, `cot: 20`).

## Data injection (Node-RED → JSON-SCADA, monitoring)

Client → driver:

```json
{ "type": "updates", "data": [
  { "address": "PLANT1~LINE2~temperature", "value": 71.4, "pointType": "analog",
    "invalid": false, "timestamp": "2026-07-04T12:00:00.000Z", "timestampOk": true,
    "description": "Line 2 temperature", "unit": "C", "isEvent": false } ] }
```

Point fields:

| Field | Required | Notes |
|---|---|---|
| `address` | yes | maps to `protocolSourceObjectAddress`; `~` splits into group1/2/3 + description |
| `value` | yes | number, boolean, string, or object |
| `pointType` | no | `analog` \| `digital` \| `string` \| `json`; inferred from `value` if omitted |
| `invalid` | no | quality flag → `invalidAtSource` |
| `timestamp` | no | ISO string, epoch seconds, epoch ms, or Date |
| `timestampOk` | no | set true only if `timestamp` is a real field time |
| `description`, `unit`, `group1..3`, `isEvent` | no | used on auto-creation |
| `commandable` | no | also create a command tag (`origin:'command'`) for this address |
| `supervisedAddress` | no | link the command tag to this supervised twin |

Unknown addresses are auto-created when the connection has `autoCreateTags: true`,
otherwise counted and dropped.

## Data distribution (JSON-SCADA → Node-RED)

Driver → client (spontaneous, batched):

```json
{ "type": "update", "tags": [
  { "tag": "PLANT1~LINE2~temperature", "pointKey": 910003, "value": 71.4,
    "valueString": "71.4", "valueJson": null, "invalid": false, "alarmed": false,
    "timeTag": "...", "timeTagAtSource": "...", "timeTagAtSourceOk": true,
    "group1": "PLANT1", "group2": "LINE2", "group3": "", "type": "analog",
    "description": "Line 2 temperature", "unit": "C", "cot": 3 } ] }
```

- `cot: 3` = spontaneous; `cot: 20` = snapshot/integrity.
- `snapshot` messages use the same tag shape but `type:"snapshot"`.

## On-demand read

Client → driver:

```json
{ "type": "read", "tags": ["KAW2AL-21LT7"] }
```

or `{ "type": "read", "topics": ["KAW2"] }` → the driver replies with one `snapshot`.

## Commands, Node-RED → field device

Client → driver (only if the connection has `commandsEnabled: true`):

```json
{ "type": "command", "tag": "KAW2KL-21CB7----K", "value": 1 }
```

`pointKey` may be used instead of `tag`. Driver → client:

```json
{ "type": "commandAck", "ok": true, "tag": "KAW2KL-21CB7----K", "error": null }
```

The driver refuses (`ok:false`) if the tag is not a command tag, is `commandBlocked`,
or is owned by this same connection (loop guard).

## Commands, operator → Node-RED flow

When an operator commands a tag owned by this connection, and a client is subscribed
with `commands:true` and a matching filter, driver → client:

```json
{ "type": "command", "address": "PLANT1~LINE2~pumpCmd", "tag": "PLANT1~LINE2~pumpCmd",
  "value": 1, "valueString": "1", "pointKey": 910050, "timestamp": "..." }
```

The flow answers (best-effort feedback written back to the command document):

```json
{ "type": "commandResult", "pointKey": 910050, "ok": true }
```

(The two `command` message shapes are disambiguated by direction: a `command` a client
sends is flow→field; a `command` the driver sends is operator→flow.)

## Keep-alive, flow control, errors

- App-level: client may send `{"type":"ping"}` → driver replies `{"type":"pong"}`.
  The driver also runs WebSocket ping/pong every 20 s and reaps dead peers.
- The driver batches outbound `update`s (flush every 200 ms or 500 tags).
- Per-client outbound queue cap is 10 000 messages; on overflow the driver drops the
  oldest and sends `{"type":"overflow","dropped":N}`. Clients should treat an overflow
  as a cue to re-`subscribe` (which re-sends a snapshot) if they need a coherent image.
- Errors: `{"type":"error","code":"...","message":"..."}` with codes
  `badjson`, `notype`, `unauth`, `auth`, `unknowntype`.
