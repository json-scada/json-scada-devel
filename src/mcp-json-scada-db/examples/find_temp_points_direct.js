import fs from 'fs';
import { MongoClient } from 'mongodb';
import { ConnectionManager, Log } from "./src/jsonscada/index.js";
// suppress logs
Log.log = () => { };
const mgr = new ConnectionManager({ manageRedundancy: false });
const mongoUrl = mgr.jsConfig.mongoConnectionString;
const dbName = mgr.jsConfig.mongoDatabaseName;
async function run() {
    const client = new MongoClient(mongoUrl);
    try {
        await client.connect();
        const db = client.db(dbName);
        const results = await db.collection("realtimeData")
            .find({
            $or: [
                { tag: { $regex: "temp", $options: "i" } },
                { description: { $regex: "temperature", $options: "i" } },
                { unit: { $regex: "°C", $options: "i" } }
            ]
        })
            .project({ tag: 1, value: 1, description: 1, unit: 1 })
            .toArray();
        if (results.length > 0) {
            const output = results.map(p => `Tag: ${p.tag}, Value: ${p.value} ${p.unit || ''}, Description: ${p.description}`).join('\n');
            fs.writeFileSync("temp_points.txt", output);
        }
        else {
            fs.writeFileSync("temp_points.txt", "No temperature points found.");
        }
    }
    catch (err) {
        fs.writeFileSync("temp_points.txt", "Error: " + err);
    }
    finally {
        await client.close();
        process.exit(0);
    }
}
run();
