
import fs from 'fs';
import { ConnectionManager, Log } from "../src/jsonscada/index.js";

// suppress logs
Log.log = () => {};

const mgr = new ConnectionManager({ manageRedundancy: false });

mgr.run(async () => {
    try {
        const results = await mgr.getRealtimeDataCollection()
            .find({ unit: "kV" })
            .project({ tag: 1, value: 1, description: 1, unit: 1 })
            .toArray();

        if (results.length > 0) {
            const output = results.map(p => `Tag: ${p.tag}, Value: ${p.value} ${p.unit}, Description: ${p.description}`).join('\n');
            fs.writeFileSync("kv_points.txt", output);
        } else {
            fs.writeFileSync("kv_points.txt", "No points found with unit='kV'.");
        }
        process.exit(0);
    } catch (err) {
        fs.writeFileSync("kv_points.txt", "Error: " + err);
        process.exit(1);
    }
});
