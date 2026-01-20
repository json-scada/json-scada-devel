
import fs from 'fs';
import { DataType, Log, ConnectionManager } from "./src/jsonscada/index.js";

// suppress logs
Log.log = () => {};

const mgr = new ConnectionManager({ manageRedundancy: false });

mgr.run(async () => {
    try {
        const result = await mgr.getRealtimeDataCollection()
            .find({ group1: "KAW2", type: DataType.Analog })
            .sort({ value: -1 })
            .limit(1)
            .toArray();

        if (result.length > 0) {
            const point = result[0];
            fs.writeFileSync("max_point.txt", `Tag: ${point.tag}, Value: ${point.value}, Description: ${point.description}`);
        } else {
            fs.writeFileSync("max_point.txt", "No analog points found for group1='KAW2'.");
        }
        process.exit(0);
    } catch (err) {
        fs.writeFileSync("max_point.txt", "Error: " + err);
        process.exit(1);
    }
});
