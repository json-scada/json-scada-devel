import { z } from "zod";
import { ConnectionManager } from "../jsonscada/connection-manager.js";

export function registerInspectTools(server: any, mgr: ConnectionManager) {
  server.registerTool(
    "describe_collection",
    {
      description: "Get document count and sample documents from a collection",
      inputSchema: {
        collection: z.string().describe("The name of the collection to describe"),
      },
    },
    async ({ collection }: any) => {
      if (!mgr.status.HintMongoIsConnected) {
        return {
          content: [{ type: "text", text: "Database not connected." }],
          isError: true,
        };
      }

      try {
        const count = await mgr.db.collection(collection).countDocuments();
        const sample = await mgr.db.collection(collection).find().limit(3).toArray();
        
        return {
          content: [{ 
            type: "text", 
            text: `Collection: ${collection}\n` +
                  `Total Documents: ${count}\n` +
                  `Sample Structure (up to 3 docs):\n${JSON.stringify(sample, null, 2)}`
          }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error describing collection: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "list_database_info",
    { description: "List all collections and their document counts" },
    async () => {
      if (!mgr.status.HintMongoIsConnected) {
        return {
          content: [{ type: "text", text: "Database not connected." }],
          isError: true,
        };
      }

      try {
        const collections = await mgr.db.listCollections().toArray();
        const results = [];

        for (const col of collections) {
          const count = await mgr.db.collection(col.name).countDocuments();
          results.push({
            name: col.name,
            count: count,
          });
        }

        return {
          content: [{ 
            type: "text", 
            text: "Collections in database:\n" + results.map(c => `- ${c.name}: ${c.count} documents`).join("\n")
          }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error listing database info: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_collection_fields",
    {
      description: "Inspect a collection to find all unique top-level fields",
      inputSchema: {
        collection: z.string().describe("The name of the collection to inspect"),
      },
    },
    async ({ collection }: any) => {
      if (!mgr.status.HintMongoIsConnected) {
        return {
          content: [{ type: "text", text: "Database not connected." }],
          isError: true,
        };
      }

      try {
        const sample = await mgr.db.collection(collection).find().limit(100).toArray();
        const fields = new Set<string>();
        
        sample.forEach(doc => {
          Object.keys(doc).forEach(key => fields.add(key));
        });

        return {
          content: [{ 
            type: "text", 
            text: `Unique top-level fields found in a sample of ${sample.length} documents from '${collection}':\n` +
                  Array.from(fields).sort().join(", ")
          }],
        };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Error inspecting fields: ${e.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "get_database_schema",
    { description: "Get the known schema for the JSON-SCADA database" },
    async () => {
      const schema = {
        realtimeData: {
          description: "Current state of all points (tags)",
          keyFields: {
            _id: "numeric pointKey (unique)",
            tag: "string key (unique)",
            type: "digital, analog, string, json",
            origin: "supervised, calculated, manual, command",
            value: "current numeric value",
            valueString: "current string value",
            timeTag: "last update time",
            unit: "unit of measurement",
            group1: "main grouping (e.g. station)",
            group2: "secondary grouping (e.g. bay)",
            group3: "lowest level grouping (e.g. equipment)"
          }
        },
        hist: {
          description: "Historical data for points",
          keyFields: {
            timeTag: "timestamp",
            tag: "point tag",
            value: "recorded value",
            quality: "data quality flags"
          }
        },
        soeData: {
          description: "Sequence of Events (SOE)",
          keyFields: {
            timeTag: "event timestamp",
            tag: "point tag",
            description: "point description",
            eventText: "text describing the event",
            value: "numeric value at event"
          }
        },
        commandsQueue: {
          description: "Queue for commands to be dispatched",
          keyFields: {
            tag: "point tag",
            value: "command numeric value",
            timeTag: "insertion time",
            delivered: "boolean flag for delivery status",
            originatorUserName: "user who sent the command"
          }
        }
      };

      return {
        content: [{ 
          type: "text", 
          text: "JSON-SCADA Known Database Schema:\n" + JSON.stringify(schema, null, 2)
        }],
      };
    }
  );
}
