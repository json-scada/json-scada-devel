import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import crypto from "node:crypto";
import { registerPointsTools } from "./tools/points.js";
import { registerCommandsTools } from "./tools/commands.js";
import { registerCollectionsTools } from "./tools/collections.js";
import { registerInspectTools } from "./tools/inspect.js";
import { ConnectionManager } from "./jsonscada/connection-manager.js";
import { Log } from "./jsonscada/index.js";

const server = new McpServer({
  name: "mcp-json-scada-db",
  version: "0.1.0",
});

// Initialize Connection Manager
// We are not using redundancy management for the MCP server itself (manageRedundancy: false)
const mgr = new ConnectionManager({ manageRedundancy: false });

// Register Tools
registerPointsTools(server, mgr);
registerCommandsTools(server, mgr);
registerCollectionsTools(server, mgr);
registerInspectTools(server, mgr);

// Resource: Schema
server.registerResource(
  "schema",
  "json-scada://schema",
  { description: "JSON-SCADA Database Schema Summary" },
  async (uri) => {
    return {
      contents: [{
        uri: uri.href,
        text: `JSON-SCADA Database Schema Summary:
- realtimeData: Contains the current state of all points (tags). Fields: _id (pointKey), tag, description, type, value, timeTag, unit, etc.
- hist: Historical data for points. Fields: timeTag, tag, value, quality.
- soeData: Sequence of Events. Fields: timeTag, tag, description, eventText, value.
- commandsQueue: Queue for commands to be dispatched. Fields: tag, value, timeTag, delivered.
- processInstances: Status and config of system processes.
- protocolDriverInstances: Status and config of protocol drivers.
- protocolConnections: Configuration of individual communication links.
- userActions: Log of actions performed by users.`
      }]
    };
  }
);

async function main() {
  // Start MongoDB connection
  mgr.run(() => {
    Log.log("MCP Server connected to MongoDB");
  });

  const transportType = process.env["MCP_TRANSPORT"] || (process.argv.includes("--http") ? "http" : "stdio");

  try {
    if (transportType === "http") {
      const bind = process.env["BIND"] || (process.argv.find(arg => arg.startsWith("--bind="))?.split("=")[1]) || "127.0.0.1";
      const portArg = process.argv.find(arg => arg.startsWith("--port="))?.split("=")[1];
      const port = parseInt(portArg || process.env["PORT"] || "6001", 10);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      await server.connect(transport);

      const httpServer = createServer(async (req, res) => {
        try {
          await transport.handleRequest(req, res);
        } catch (error) {
          console.error("HTTP request error:", error);
          res.statusCode = 500;
          res.end("Internal Server Error");
        }
      });

      httpServer.listen(port, bind, () => {
        Log.log(`MCP Server running on HTTP at http://${bind}:${port}`);
      });
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      Log.log("MCP Server running on stdio");
    }
  } catch (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
