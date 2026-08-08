# DOX: src/lib60870.netcore — IEC 60870-5-104/101 Protocol Drivers

## Purpose

.NET Core implementation of IEC 60870-5-104 (TCP/TLS) and IEC 60870-5-101 (serial/TCP) client and server protocol drivers. The largest and most mature protocol implementation in JSON-SCADA.

## Ownership

- lib60870.netcore owns the IEC 104/101 protocol driver implementations
- Each sub-project (iec104server, iec104client, iec101server, iec101client) owns its driver logic
- The shared `lib60870.netcore` library owns the native protocol library bindings

## Local Contracts

- **Solution:** `lib60870.netcore.sln` — Visual Studio solution file
- **Language:** C# .NET Core 8.0+
- **Sub-projects:**
  - `iec104server/` — IEC 60870-5-104 server (ASDU receive handler, interrogation handler)
  - `iec104client/` — IEC 60870-5-104 client (ASDU receive, redundancy)
  - `iec101server/` — IEC 60870-5-101 server (ASDU receive, interrogation)
  - `iec101client/` — IEC 60870-5-101 client (ASDU receive, redundancy)
  - `lib60870.netcore/` — C# bindings to lib60870 native library
- **Common files across sub-projects:**
  - `AsduReceiveHandler.cs` — ASDU message processing
  - `Common_srv_cli.cs` — shared server/client logic
  - `Program.cs` — main entry point
  - `InterrogationHandler.cs` — (server) ASDU interrogation
  - `MongoChangeStream.cs` — (server) MongoDB change stream subscription
- **Native dependency:** `lib60870.dll` in `bin/` or `bincd/`
- **Config:** INI file via Supervisor or command-line args
- **Build:** `dotnet build` on each sub-project

## Work Guidance

- Server drivers use MongoDB Change Streams for real-time command dispatch
- Client drivers use MongoDB for tag definitions and real-time data storage
- Redundancy module (`Redundancy.cs`) provides connection failover for clients
- TLS support both as client and server
- Common ASDU type handling across all four sub-projects
- IEC 101 supports serial (RTU/ASCII) and TCP transport

## Verification

- `dotnet build iec104server/iec104server.csproj` — each project builds cleanly
- `dotnet build iec104client/iec104client.csproj`
- `dotnet build iec101server/iec101server.csproj`
- `dotnet build iec101client/iec101client.csproj`
- Test IEC 104: connect a client to the server on port 2404, verify data exchange
- Test IEC 101: use a serial loopback or TCP simulation
