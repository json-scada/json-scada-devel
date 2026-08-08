# DOX: src/libplctag — CIP Ethernet/IP Client Driver

## Purpose

.NET Core client driver for CIP Ethernet/IP (Allen-Bradley / Rockwell PLCs) using the libplctag library. Reads/writes tags from ControlLogix, CompactLogix, MicroLogix, and SLC PLCs.

## Ownership

- libplctag owns the CIP Ethernet/IP protocol driver

## Local Contracts

- **Language:** C# .NET Core 8.0+
- **Solution:** `PLCTagsClient/PLCTagsClient.sln` / `PLCTagsClient.csproj`
- **Sub-projects:**
  - `PLCTagsClient/` — C# client driver
    - Standard files: `Program.cs`, `PlcScanHandler.cs`, `Common_srv_cli.cs`, `MongoCommands.cs`, `MongoUpdate.cs`, `Redundancy.cs`
  - `libplctag.NET/` — .NET bindings for libplctag native library
- **Native dependency:** `libplctag.dll` / `plctag.dll` (provided in `bin/`)
- **Config:** INI file via Supervisor or environment variables
- **Build:** `dotnet build`

## Work Guidance

- Connects to CIP Ethernet/IP compatible PLCs (AB ControlLogix, CompactLogix, etc.)
- Tag-based read/write (different from register-based Modbus)
- Uses libplctag native library via .NET P/Invoke
- Follows the standard JSON-SCADA .NET driver pattern
- Windows x64 only due to native DLL dependency

## Verification

- `dotnet build` — project builds cleanly
- Test with a PLC simulator or real ControlLogix/CompactLogix
