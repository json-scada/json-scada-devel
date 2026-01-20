
import fs from 'fs';
import { ConnectionManager } from "./src/jsonscada/connection-manager.js";
import { Log } from "./src/jsonscada/index.js";

// suppress logs
Log.log = () => {};

const mgr = new ConnectionManager({ manageRedundancy: false });

mgr.run(async (client, db) => {
    try {
        const count = await mgr.getRealtimeDataCollection().countDocuments({});
        fs.writeFileSync("result.txt", `There are ${count} points in the database.`);
        process.exit(0);
    } catch (err) {
        fs.writeFileSync("result.txt", "Error: " + err);
        process.exit(1);
    }
});
