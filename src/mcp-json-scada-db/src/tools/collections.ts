import { z } from "zod";
import { ConnectionManager } from "../jsonscada/connection-manager.js";

export function registerCollectionsTools(server: any, mgr: ConnectionManager) {
  server.tool(
    "list_collections",
    {},
    async () => {
      if (!mgr.status.HintMongoIsConnected) {
         return {
          content: [{ type: "text", text: "Database not connected." }],
          isError: true,
        };
      }
      const collections = await mgr.db.listCollections().toArray();
      return {
        content: [{ type: "text", text: JSON.stringify(collections.map(c => c.name), null, 2) }],
      };
    }
  );

  server.tool(
    "query_collection",
    {
      collection: z.string().describe("The collection name to query"),
      query: z.string().optional().describe("JSON string representing the MongoDB query"),
      limit: z.number().optional().default(5),
    },
    async ({ collection, query, limit }: any) => {
      if (!mgr.status.HintMongoIsConnected) {
         return {
          content: [{ type: "text", text: "Database not connected." }],
          isError: true,
        };
      }
      let filter = {};
      if (query) {
        try {
          filter = JSON.parse(query);
        } catch (e) {
          return {
            content: [{ type: "text", text: `Invalid query JSON: ${e}` }],
            isError: true,
          };
        }
      }

      const results = await mgr.db
        .collection(collection)
        .find(filter)
        .limit(limit)
        .toArray();

      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );
}
