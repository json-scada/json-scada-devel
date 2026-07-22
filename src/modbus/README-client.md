# MODBUS Client Driver

Polls Modbus devices and updates {json:scada} tags; dispatches commands from the
`commandsQueue`. Registers as protocol driver **`MODBUS`**. See [README.md](README.md)
for transports, byte orders, and addressing shared with the server.

## Connection configuration (`protocolConnections`)

```js
use json_scada_db_name
db.protocolConnections.insertOne({
  protocolDriver: 'MODBUS',
  protocolDriverInstanceNumber: 1.0,
  protocolConnectionNumber: 3001.0,   // system-wide unique
  name: 'PLC_AREA_51',
  description: 'Modbus TCP PLC',
  enabled: true,
  commandsEnabled: true,

  connectionMode: 'TCP Active',        // TCP Active | TLS Active | Serial | RTU over TCP | RTU over TLS
  ipAddresses: ['192.168.0.101:502', '192.168.0.102:502'], // failover list (TCP/TLS/RTU-over-TCP/TLS)
  ipAddressLocalBind: '',              // optional local interface for the outgoing socket
  portName: 'COM3',                    // serial only (Linux: /dev/ttyUSB0)
  baudRate: 9600.0, parity: 'Even', stopBits: 'One', handshake: 'None',

  timeoutMs: 1000.0,                   // response timeout per request
  maxRetries: 2.0,                     // per request before the block is failed
  pollingInterval: 1000.0,             // ms base scan cycle
  giInterval: 300.0,                   // s integrity cycle (republish all values)
  interRequestDelayMs: 0.0,            // pacing for slow lines/gateways
  interFrameDelayMs: 0.0,              // RTU idle-gap; 0 = auto (3.5 char times)

  maxReadRegisters: 125.0,             // clamp read block size
  maxReadCoils: 2000.0,
  maxAddressGap: 8.0,                  // coalesce blocks across small unused gaps

  byteOrder16: 'AB', byteOrder32: 'ABCD', byteOrder64: 'ABCDEFGH', byteOrderStr: 'AB',
  stringEncoding: 'latin1',            // latin1 | utf8 | ascii
  useModiconAddresses: false,
  useMaskWrite: true,                  // FC22 for .b<n> writes; false = read-modify-write

  // TLS (connectionMode TLS Active / RTU over TLS)
  localCertFilePath: '', privateKeyFilePath: '', privateKeyPassphrase: '',
  peerCertFilePath: '', chainValidation: true, allowOnlySpecificCertificates: false,
  cipherList: '', allowTLSv12: true, allowTLSv13: true,

  autoCreateTags: false,
  topics: ['PLC1_FLOW|hr:4:float32_cdab', 'PLC1_STAT|hr:20:uint16[10]'],

  keepProtocolRunningWhileInactive: false,
  stats: null
})
```

## Tag configuration (`realtimeData`)

```js
db.realtimeData.updateOne({ tag: 'A_TAG_NAME' }, {
  $set: {
    protocolSourceConnectionNumber: 3001.0,
    protocolSourceCommonAddress: 1.0,          // Modbus unit id
    protocolSourceObjectAddress: 'hr:4',        // area:offset[.bN]
    protocolSourceASDU: 'float32_cdab',         // type[_byteorder]
    protocolSourceCommandDuration: 0.0,
    protocolSourceCommandUseSBO: false,
    kconv1: 1.0,
    kconv2: 0.0
  }
})
```

- **protocolSourceObjectAddress** — `hr:4`, `ir:20`, `co:5`, `di:3`, `hr:100.b7`. See
  addressing in [README.md](README.md).
- **protocolSourceASDU** — value type and optional byte order (`uint16`, `int32_le`,
  `float32_cdab`, `string:16`, `uint16.b3` is expressed via the address `.b` suffix).
  Empty → `bool` for `co`/`di`, `uint16` for `hr`/`ir`.
- **protocolSourceCommonAddress** — unit id (0–255). `0` = broadcast (commands only).
- **kconv1 / kconv2** — engineering scaling `value = raw*kconv1 + kconv2` (supervision).
  Commands apply the inverse. `kconv1 = -1` inverts digitals.

## Commands

New `commandsQueue` inserts for this connection are dispatched as:
`bool` → FC5; `uint16/int16/bcd16` → FC6; multi-register / string → FC16; `.b<n>` → FC22
(or read-modify-write when `useMaskWrite: false`). The write echo/exception is the only
confirmation Modbus offers, so `ack` reflects it; the driver sets `delivered`, `ack`,
`ackTimeTag`, and `resultDescription` (`OK`, `timeout`, or the exception text). Out-of-range
values are rejected before transmission with `cancelReason`/`resultDescription`. Broadcast
(unit 0) writes are acknowledged optimistically since the device does not reply.

## Auto tag creation

With `autoCreateTags: true`, entries in `topics` create missing tags:
`"TAG_NAME|<area>:<offset>:<type[_byteorder]>[count]"`. `[count]` expands arrays to
`TAG[0]..TAG[n-1]` at consecutive addresses. Example:
`"PLC1_STAT|hr:20:uint16[10]"` scans 10 holding registers starting at 20.

## Command-line arguments

1. Instance number (default 1)
2. Log level 0–3 (default 1)
3. Config file path (default `../../conf/json-scada.json`)
