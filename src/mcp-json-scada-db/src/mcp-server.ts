/*
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import crypto from "node:crypto";
import { registerPointsTools } from "./tools/points.js";
import { registerCommandsTools } from "./tools/commands.js";
import { registerCollectionsTools } from "./tools/collections.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerStatusTools } from "./tools/status.js";
import { ConnectionManager } from "./jsonscada/connection-manager.js";
import { Log } from "./jsonscada/index.js";
import packageInfo from "../package.json" with { type: "json" };

// Initialize Connection Manager
// We are not using redundancy management for the MCP server itself (manageRedundancy: false)
const mgr = new ConnectionManager({ manageRedundancy: false });

// Builds a fully configured MCP server instance. A factory is needed because
// each transport (stdio, or one per HTTP session) requires its own server.
function buildServer(): McpServer {
  const server = new McpServer({
    name: packageInfo.name || "mcp-json-scada-db",
    version: packageInfo.version || "0.0.0",
  });

  registerPointsTools(server, mgr);
  registerCommandsTools(server, mgr);
  registerCollectionsTools(server, mgr);
  registerInspectTools(server, mgr);
  registerHistoryTools(server, mgr);
  registerStatusTools(server, mgr);

  // Resource: Schema
  server.registerResource(
    "schema",
    "json-scada://schema",
    { description: "JSON-SCADA Database Schema Summary" },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.href,
            text: `JSON-SCADA Database Schema Summary:
- realtimeData: Contains the current state of all points (tags). Fields: _id (pointKey), tag, description, type, value, timeTag, unit, invalid, alarmed, group1/2/3, etc.
- hist: Historical data for points. Fields: timeTag, tag, value, timeTagAtSource, invalid.
- soeData: Sequence of Events. Fields: timeTag, timeTagAtSource, tag, description, eventText, ack.
- commandsQueue: Queue for commands to be dispatched. Fields: tag, value, timeTag, delivered, ack, originatorUserName.
- processInstances: Status and config of system processes.
- protocolDriverInstances: Status and config of protocol drivers.
- protocolConnections: Configuration of individual communication links.
- userActions: Audit log of actions performed by users.`,
          },
        ],
      };
    }
  );

  return server;
}

async function main() {
  // Start MongoDB connection (runs a reconnect loop in the background)
  mgr
    .run(() => {
      Log.log("MCP Server connected to MongoDB");
    })
    .catch((error) => {
      console.error("Fatal error in MongoDB connection loop:", error);
      process.exit(1);
    });

  const transportType =
    process.env["MCP_TRANSPORT"] ||
    (process.argv.includes("--http") ? "http" : "stdio");

  try {
    if (transportType === "http") {
      const bind =
        process.env["BIND"] ||
        process.argv.find((arg) => arg.startsWith("--bind="))?.split("=")[1] ||
        "127.0.0.1";
      const portArg = process.argv
        .find((arg) => arg.startsWith("--port="))
        ?.split("=")[1];
      const port = parseInt(portArg || process.env["PORT"] || "6001", 10);

      // One transport (and server) per MCP session, keyed by session id
      const transports: Record<string, StreamableHTTPServerTransport> = {};

      const httpServer = createServer(async (req, res) => {
        try {
          const sessionId = req.headers["mcp-session-id"] as string | undefined;
          let transport = sessionId ? transports[sessionId] : undefined;

          if (!transport) {
            if (sessionId) {
              // session expired or unknown
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json");
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: { code: -32001, message: "Session not found" },
                  id: null,
                })
              );
              return;
            }
            // new session: create a transport and a server for it
            // (non-initialize requests without a session id are rejected by
            // the transport itself)
            const newTransport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (sid) => {
                transports[sid] = newTransport;
                Log.log("MCP session initialized: " + sid, Log.levelDetailed);
              },
            });
            newTransport.onclose = () => {
              if (newTransport.sessionId) {
                delete transports[newTransport.sessionId];
                Log.log(
                  "MCP session closed: " + newTransport.sessionId,
                  Log.levelDetailed
                );
              }
            };
            await buildServer().connect(newTransport);
            transport = newTransport;
          }

          await transport.handleRequest(req, res);
        } catch (error) {
          console.error("HTTP request error:", error);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end("Internal Server Error");
          }
        }
      });

      httpServer.listen(port, bind, () => {
        Log.log(`MCP Server running on HTTP at http://${bind}:${port}`);
      });
    } else {
      const transport = new StdioServerTransport();
      await buildServer().connect(transport);
      Log.log("MCP Server running on stdio");
    }
  } catch (error) {
    console.error("Failed to start MCP server:", error);
    process.exit(1);
  }
}

async function shutdown(signal: string) {
  Log.log(`Received ${signal}, shutting down...`);
  try {
    if (mgr.client) await mgr.client.close();
  } catch {
    // ignore errors while closing
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
