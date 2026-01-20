import { z } from "zod";
import { ConnectionManager } from "../jsonscada/connection-manager.js";

export function registerPointsTools(server: any, mgr: ConnectionManager) {
  server.tool(
    "search_points",
    {
      filter: z.string().optional().describe("Regex filter for tag or description"),
      group1: z.string().optional().describe("Filter by group1"),
      limit: z.number().optional().default(10),
      offset: z.number().optional().default(0),
    },
    async ({ filter, group1, limit, offset }: any) => {
      if (!mgr.status.HintMongoIsConnected) {
        return {
          content: [{ type: "text", text: "Database not connected." }],
          isError: true,
        };
      }

      const query: any = {};
      if (filter) {
        query.$or = [
          { tag: { $regex: filter, $options: "i" } },
          { description: { $regex: filter, $options: "i" } },
        ];
      }
      if (group1) {
        query.group1 = group1;
      }

      const points = await mgr
        .getRealtimeDataCollection()
        .find(query)
        .skip(offset)
        .limit(limit)
        .toArray();

      return {
        content: [{ type: "text", text: JSON.stringify(points, null, 2) }],
      };
    }
  );

  server.tool(
    "get_point",
    {
      tag: z.string().describe("The tag name of the point"),
    },
    async ({ tag }: any) => {
      if (!mgr.status.HintMongoIsConnected) {
        return {
          content: [{ type: "text", text: "Database not connected." }],
          isError: true,
        };
      }
      
      const point = await mgr
        .getRealtimeDataCollection()
        .findOne({ tag });

      if (!point) {
        return {
          content: [{ type: "text", text: `Point with tag '${tag}' not found.` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(point, null, 2) }],
      };
    }
  );
}
