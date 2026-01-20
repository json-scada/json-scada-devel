import { ConnectionManager } from "./src/jsonscada/connection-manager.js";
const mgr = new ConnectionManager({ manageRedundancy: false });
mgr.run(async (client, db) => {
    try {
        const count = await mgr.getRealtimeDataCollection().countDocuments({});
        console.log(`@mcp: There are ${count} points in the database.`);
        process.exit(0);
    }
    catch (err) {
        console.error(err);
        process.exit(1);
    }
});
