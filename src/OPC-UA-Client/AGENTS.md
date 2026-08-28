# DOX: src/OPC-UA-Client — OPC UA Client Driver

## Purpose

.NET Core OPC UA client driver for JSON-SCADA. Connects to OPC UA servers, reads/writes tags, and synchronizes data with MongoDB.

## Ownership

- OPC-UA-Client owns the OPC UA client protocol driver

## Local Contracts

- **Language:** C# .NET Core 8.0+
- **Solution:** `OPC-UA-Client.sln` / `OPC-UA-Client.csproj`
- **Standard files:**
  - `Program.cs` — main entry point
  - `AsduReceiveHandler.cs` — ASDU-style message handling
  - `Common_srv_cli.cs` — shared server/client logic
  - `MongoCommands.cs` — MongoDB read/write operations
  - `MongoUpdate.cs` — MongoDB update helpers
  - `TagsCreation.cs` — tag auto-creation from OPC UA server
  - `Redundancy.cs` — connection failover support
- **Config:** INI file via Supervisor or environment variables
- **Build:** `dotnet build`
- **Dependency:** OPC UA .NET Standard libraries (Opc.Ua.Client, Opc.Ua.Core, etc.)

## Work Guidance

- Connects to OPC UA servers with security (None, Sign, SignAndEncrypt)
- Supports browsing the OPC UA address space for tag discovery
- Auto-creates JSON-SCADA tags from discovered OPC UA nodes
- Handles reconnection with exponential backoff
- Follows the standard JSON-SCADA .NET driver pattern (same structure as iec61850_client, OPC-DA-Client)

## Verification

- `dotnet build` — project builds cleanly
- Test connection to a local OPC UA server (e.g., OPC UA Server simulator)
- Verify tag discovery and data synchronization to MongoDB
