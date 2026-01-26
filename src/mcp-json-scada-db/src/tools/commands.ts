import { z } from "zod";
import { ConnectionManager } from "../jsonscada/connection-manager.js";
import { Origin } from "../jsonscada/types.js";

export function registerCommandsTools(server: any, mgr: ConnectionManager) {
  server.registerTool(
    "send_command",
    {
      description: "Send a command to a point",
      inputSchema: {
        tag: z.string().describe("The tag name of the command point"),
        value: z.number().describe("The numeric value for the command"),
        username: z.string().optional().default("mcp-agent"),
      },
    },
    async ({ tag, value, username }: any) => {
      if (!mgr.status.HintMongoIsConnected) {
        return {
          content: [{ type: "text", text: "Database not connected." }],
          isError: true,
        };
      }

      const point = await mgr
        .getRealtimeDataCollection()
        .findOne({ tag, origin: Origin.Command } as any);

      if (!point) {
        return {
          content: [{ type: "text", text: `Command point with tag '${tag}' not found or is not a command origin.` }],
          isError: true,
        };
      }

      const command = {
        protocolSourceConnectionNumber: point.protocolSourceConnectionNumber || 0,
        protocolSourceCommonAddress: point.protocolSourceCommonAddress || 0,
        protocolSourceObjectAddress: point.protocolSourceObjectAddress || 0,
        protocolSourceASDU: point.protocolSourceASDU || 0,
        protocolSourceCommandDuration: point.protocolSourceCommandDuration || 0,
        protocolSourceCommandUseSBO: point.protocolSourceCommandUseSBO || false,
        pointKey: point._id || 0,
        tag: point.tag || "",
        timeTag: new Date(),
        value: value,
        valueString: value.toString(),
        originatorUserName: username,
        originatorIpAddress: "127.0.0.1",
        delivered: false,
      };

      const result = await mgr
        .getCommandsQueueCollection()
        .insertOne(command as any);

      return {
        content: [{ type: "text", text: `Command sent. ID: ${result.insertedId}` }],
      };
    }
  );
}
