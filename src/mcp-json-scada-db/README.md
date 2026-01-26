# {json:scada} MCP Database Server

This is a Model Context Protocol (MCP) server that provides access to a {json:scada} MongoDB database. It allows AI models to query real-time data, historical records, system logs, and send commands to control points within the SCADA system.

## Features

- **Point Discovery**: Search for points by tag, description, or group.
- **Data Access**: Retrieve current values and attributes for specific tags.
- **Database Exploration**: List collections, inspect schemas, and perform custom MongoDB queries.
- **Command Dispatch**: Send commands to control points (requires command origin).
- **System Inspection**: Monitor process instances and driver statuses.

## Configuration

The server expects a MongoDB connection string. You can configure this via environment variables or a configuration file in the parent directory (standard {json:scada} behavior).

### Environment Variables

- `MCP_TRANSPORT`: Set to `http` to run as an HTTP streamable server (defaults to `stdio`).
- `PORT`: HTTP port if running in HTTP mode (defaults to `6001`).
- `BIND`: Binding address if running in HTTP mode (defaults to `127.0.0.1`), use `0.0.0.0` to allow external connections from any host.

### Command Line Arguments

- **_1st arg. - Instance Number_** \[Integer] - Instance number to be executed. **Optional argument, default=1**. Env. variable: **JS_CSCUSTOMPROC_INSTANCE**.
- **_2nd arg. - Log. Level_** \[Integer] - Log level (0=minimum,1=basic,2=detailed,3=debug). **Optional argument, default=1**. Env. variable: **JS_CSCUSTOMPROC_LOGLEVEL**.
- **_3rd arg. - Config File Path/Name_** \[String] - Path/name of the JSON-SCADA config file. **Optional argument, default="../conf/json-scada.json"**. Env. variable: **JS_CONFIG_FILE**.
- **_4th arg. - --http_** \[String] - MCP transport (http or stdio). **Optional argument, default=stdio**. Env. variable: **MCP_TRANSPORT**.
- **_5th arg. - --bind=ADDRESS_** \[String] - MCP bind address. **Optional argument, default=127.0.0.1**. Env. variable: **BIND**.
- **_6th arg. - --port=PORT_** \[Integer] - MCP port. **Optional argument, default=6001**. Env. variable: **PORT**.

## Usage

### Connect to the server

Via stdio, command:
c:\json-scada\platform-windows\nodejs-runtime\node.exe c:\json-scada\src\mcp-json-scada-db\dist\mcp-server.js 1 1 c:\json-scada\conf\json-scada.json

### Registered Tools

The server exposes the following tools to the MCP client:

- `search_points`: Search for points using filters.
- `get_point`: Get full details of a specific point.
- `send_command`: Write a value to a command point.
- `list_collections`: View all available database collections.
- `query_collection`: Run a custom JSON query on any collection.
- `describe_collection`: Get document counts and samples.
- `list_database_info`: High-level summary of the database.
- `get_collection_fields`: Inspect unique fields in a collection.
- `get_database_schema`: View the known {json:scada} schema.

### Registered Resources

- `json-scada://schema`: Provides a detailed text summary of the database structure and key collections.
