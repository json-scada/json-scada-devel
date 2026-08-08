# DOX: src/iec61850_client — IEC 61850 MMS Client Driver

## Purpose

.NET Core IEC 61850 MMS client driver for JSON-SCADA. Connects to IEC 61850 devices (IEDs, relays, RTUs) via MMS protocol, reads/writes data attributes, and synchronizes with MongoDB.

## Ownership

- iec61850_client owns the IEC 61850 MMS client protocol driver

## Local Contracts

- **Language:** C# .NET Core 8.0+
- **Solution:** `iec61850_client.sln` / `iec61850_client.csproj`
- **Standard files:**
  - `Main.cs` — main entry point
  - `AsduReceiveHandler.cs` — ASDU-style message handling
  - `Common_srv_cli.cs` — shared server/client logic
  - `MongoCommands.cs` — MongoDB read/write operations
  - `MongoUpdate.cs` — MongoDB update helpers
  - `TagsCreation.cs` — tag auto-creation from ICD/CID files
  - `Redundancy.cs` — connection failover support
- **Dependency:** `libiec61850` (native C library via .NET interop — `IEC61850.NET.core.2.0.dll`)
- **Config:** INI file via Supervisor or environment variables
- **Build:** `dotnet build`

## Work Guidance

- Uses libiec61850 C library via .NET P/Invoke bindings
- Supports TLS for secure MMS connections
- ICD/CID file parsing for automatic tag creation
- Handles IED connection lifecycle with redundancy/failover
- Follows the standard JSON-SCADA .NET driver pattern (same as OPC-UA-Client, OPC-DA-Client, Dnp3Client)

## Verification

- `dotnet build` — project builds cleanly
- Test connection to an IEC 61850 IED or simulator (e.g., libiec61850 example server)
- Verify tag discovery and data synchronization to MongoDB
