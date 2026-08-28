# Interop & end-to-end test recipes

The unit and loopback suites (`npm test`) validate the protocol core and the full
client↔server path in-process. These recipes cover interoperability with third-party
Modbus tools and end-to-end behavior with MongoDB. They are manual (require external
tools / a database) and are not run by `npm test`.

## Tools

- **diagslave** — free Modbus slave simulator (TCP, RTU, RTU-over-TCP "enron"/encapsulated).
- **modpoll** — free Modbus master poller.
- **pymodbus** — Python library; used for TLS interop and byte-order cross-checks.
- Serial loopback: `com0com` (Windows) or `socat -d -d pty,raw,echo=0 pty,raw,echo=0` (Linux).

## 1. Client against diagslave (TCP)

```bash
# terminal 1: slave with 32 holding registers on port 5020
diagslave -m tcp -p 5020

# configure a MODBUS connection with ipAddresses ["127.0.0.1:5020"] and a tag at hr:0,
# then run the client:
node ../../dist/client/main.js 1 2 ../../../../conf/json-scada.json

# terminal 3: write a register with modpoll and watch realtimeData.sourceDataUpdate change
modpoll -m tcp -p 5020 -r 1 -t 4 127.0.0.1 1234
```

RTU serial: `diagslave -m rtu /dev/ttyp0` and connection `connectionMode: "Serial"`,
`portName: "/dev/ttyp1"`. RTU-over-TCP: `diagslave -m enron -p 5020` with
`connectionMode: "RTU over TCP"`.

## 2. Server polled by modpoll

```bash
# run the server (connectionMode "TCP Passive", ipAddressLocalBind "0.0.0.0:5020")
node ../../dist/server/main.js 1 2 ../../../../conf/json-scada.json

# read holding registers 1..10
modpoll -m tcp -p 5020 -r 1 -c 10 -t 4 127.0.0.1

# write a mapped command point and confirm a commandsQueue insert appears
modpoll -m tcp -p 5020 -r 101 -t 4 127.0.0.1 4321
```

## 3. TLS interop with pymodbus

```python
# server side: run MODBUS_SERVER in "TLS Passive" with cert/key/ca configured, then:
from pymodbus.client import ModbusTlsClient
c = ModbusTlsClient('127.0.0.1', port=802, certfile='client.crt',
                    keyfile='client.key', server_hostname='localhost')
c.connect()
print(c.read_holding_registers(0, count=4, slave=1).registers)
```

## 4. Byte-order cross-check against pymodbus

Encode a value with `pymodbus.payload.BinaryPayloadBuilder` under a known word/byte order,
write it to a slave, point a MODBUS tag at it with the matching ASDU suffix (e.g.
`float32_cdab`), and confirm `valueAtSource` matches. The committed unit-test fixtures in
`test/unit/datacodec.test.ts` already assert the standard reference values.

## 5. Robustness / fuzz (optional)

Feed random byte streams into the framers and PDU parser; they must never throw, only
reject. A seeded fuzz loop can be added under `test/unit/` guarded by an env flag.
