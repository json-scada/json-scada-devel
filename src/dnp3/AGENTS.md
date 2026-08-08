# DOX: src/dnp3 — DNP3 Protocol Drivers

## Purpose

DNP3 client and server protocol drivers for JSON-SCADA. Includes a C# client wrapping opendnp3 via CLR, and a C++ standalone server. Windows x64 only.

## Ownership

- dnp3 owns the DNP3 protocol driver implementations
- opendnp3 is a git submodule (upstream project)

## Local Contracts

- **Sub-projects:**
  - `Dnp3Client/` — C# DNP3 client (wraps opendnp3 via CLR adapter)
    - `Dnp3Client.csproj`, `Dnp3Client.sln`
    - Common files: `AsduReceiveHandler.cs`, `Common_srv_cli.cs`, `MongoCommands.cs`, `MongoUpdate.cs`, `Program.cs`, `Redundancy.cs`
  - `Dnp3ClientCpp/` — C++ CLR adapter layer for opendnp3
  - `Dnp3Server/` — C++ standalone DNP3 server
    - `main.cpp`, `CMakeLists.txt`, `json.hpp`
  - `opendnp3/` — opendnp3 C++ library (git submodule)
- **Build:** `build-opendnp3.bat` — builds the entire DNP3 stack
- **Root build orchestration:** `CMakeLists.txt` at dnp3 root
- **Config:** INI file via Supervisor or command-line

## Work Guidance

- DNP3 is Windows x64 only due to the C++/CLR dependency
- The build pipeline: build opendnp3 → build Dnp3ClientCpp (CLR) → build Dnp3Client (C#)
- Dnp3Server is a standalone executable that connects directly to MongoDB
- TLS support for DNP3 secure authentication
- Supports TCP, UDP, TLS, and serial transport

## Verification

- Run `build-opendnp3.bat` on Windows — entire build succeeds
- `dotnet build Dnp3Client/Dnp3Client.csproj` — C# client builds
- Test client-server loopback on port 20000
