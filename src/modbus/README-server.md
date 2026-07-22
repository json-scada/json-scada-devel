# MODBUS_SERVER Driver

Exposes selected {json:scada} tags as a Modbus slave to third-party masters, and relays
their writes back into JSON-SCADA as commands. Registers as protocol driver
**`MODBUS_SERVER`**. See [README.md](README.md) for transports, byte orders, and addressing.

## Connection configuration (`protocolConnections`)

```js
use json_scada_db_name
db.protocolConnections.insertOne({
  protocolDriver: 'MODBUS_SERVER',
  protocolDriverInstanceNumber: 1.0,
  protocolConnectionNumber: 3101.0,
  name: 'MODBUS_SRV_1',
  description: 'Modbus TCP slave for external SCADA',
  enabled: true,
  commandsEnabled: true,               // false => writes answered with exception 01

  connectionMode: 'TCP Passive',       // TCP Passive | TLS Passive | Serial |
                                       // RTU over TCP Passive | RTU over TLS Passive
  ipAddressLocalBind: '0.0.0.0:502',
  maxClientConnections: 8.0,
  clientIdleTimeoutMs: 60000.0,
  ipAddresses: [],                     // optional client IP allow-list (empty = any)

  portName: 'COM4', baudRate: 9600.0, parity: 'Even', stopBits: 'One', handshake: 'None',
  interFrameDelayMs: 0.0,

  serverUnitIds: [1.0],                // unit ids served
  strictUnitId: false,                 // false (TCP) = answer any unit id
  serveUnmappedAsZero: false,          // true = read unmapped addresses as 0 (not exc 02)

  byteOrder16: 'AB', byteOrder32: 'ABCD', byteOrder64: 'ABCDEFGH', byteOrderStr: 'AB',
  stringEncoding: 'latin1',
  useModiconAddresses: false,
  invalidValuePolicy: 'last',          // last | zero  (Modbus has no quality bits)
  allowWritesToSupervised: false,      // true = write into supervised value directly

  // TLS (server side)
  localCertFilePath: '', privateKeyFilePath: '', privateKeyPassphrase: '',
  peerCertFilePath: '', chainValidation: true,   // true => require & verify client certs
  allowOnlySpecificCertificates: false, cipherList: '',
  allowTLSv12: true, allowTLSv13: true,

  keepProtocolRunningWhileInactive: false,
  stats: null
})
```

## Tag distribution (`protocolDestinations`)

Tags served by this connection carry a `protocolDestinations` array entry:

```js
db.realtimeData.updateOne({ tag: 'A_TAG_NAME' }, {
  $push: {
    protocolDestinations: {
      protocolDestinationConnectionNumber: 3101.0,
      protocolDestinationCommonAddress: 1.0,        // unit id the point lives under
      protocolDestinationObjectAddress: 'hr:100',    // area:offset[.bN]
      protocolDestinationASDU: 'float32_cdab',       // type[_byteorder]
      protocolDestinationKConv1: 1.0,
      protocolDestinationKConv2: 0.0,
      protocolDestinationGroup: 0.0,
      protocolDestinationHoursShift: 0.0
    }
  }
})
```

- Supervised tags map to any area and become **readable**. A **command** tag (one that
  has `protocolSource*` fields, or `origin: 'command'`) mapped to a writable area
  (`co`/`hr`) makes that address **writable** — a master write is relayed as a command.
- A supervised tag and its command twin may share an address (read shows status, write
  fires the command), mirroring the IEC 60870-5-104 server distribution model.
- Overlapping register claims in the same unit/area are resolved deterministically
  (first by point key wins; the conflict is logged).

## Serving reads

Values are pre-encoded into per-`(unitId, area)` register/coil banks and refreshed from a
`realtimeData` change stream, so a read is a pure memory copy. Reads of unmapped
addresses return exception **02 ILLEGAL DATA ADDRESS** unless `serveUnmappedAsZero: true`.

## Handling writes (command relay)

A write to a mapped command point:
1. is decoded with the point's ASDU/byte order and inverse `KConv1/2`;
2. becomes a `commandsQueue` insert carrying the point's **`protocolSource*`** routing, so
   whichever client driver owns the point (Modbus, IEC 104, DNP3, …) dispatches it;
3. is acknowledged to the master immediately — Modbus cannot wait for end-to-end
   confirmation.

Write outcomes: unmapped/read-only → exception 02/01; `commandsEnabled: false` →
exception 01; internal failure → exception 04. With `allowWritesToSupervised: true`, a
write to a supervised (non-command) point sets its value directly (writable register bank).

## Command-line arguments

1. Instance number (default 1)
2. Log level 0–3 (default 1)
3. Config file path (default `../../conf/json-scada.json`)
