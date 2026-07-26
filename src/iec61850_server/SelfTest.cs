/*
 * IEC 61850 Server driver for {json:scada} - offline self test (diagnostic).
 *
 * Runs the full model-build + server-start path against synthetic points, without MongoDB,
 * so the libiec61850 data model, datasets, report control blocks and control handlers can be
 * validated with any IEC 61850 client. Enable with:  iec61850_server selftest [port]
 *
 * This is a diagnostic aid only; it is never reached during normal operation.
 */

using System;
using System.Collections.Generic;
using System.Threading;
using MongoDB.Bson;

namespace IEC61850_Server
{
    partial class MainClass
    {
        static void RunSelfTest(string[] args)
        {
            LogLevel = 3;
            int port = 10102;
            if (args.Length > 1 && int.TryParse(args[1], out int p)) port = p;

            Log("=== IEC61850_SERVER SELF TEST (no MongoDB) ===");

            if (!TestDeserialization())
            {
                Log("SELF TEST: rtData deserialization FAILED.");
                Environment.Exit(-1);
            }

            srvConn = new Iec61850ServerConnection
            {
                protocolDriver = ProtocolDriverName,
                protocolDriverInstanceNumber = 1,
                protocolConnectionNumber = 8001,
                name = "IEC61850SRV",
                description = "self test",
                enabled = true,
                commandsEnabled = true,
                ipAddressLocalBind = "0.0.0.0:" + port,
                ipAddresses = new string[] { },
                topics = new string[] { },
                serverModeMultiActive = true,
                maxClientConnections = 2,
                maxQueueSize = 1000,
                useSecurity = false
            };

            PointsSnapshot = BuildSyntheticPoints();
            // optional 3rd arg: bulk-generate N extra points in one topic, to exercise the
            // model at realistic scale (large logical nodes stress the MMS type-description PDU)
            if (args.Length > 2 && int.TryParse(args[2], out int bulk) && bulk > 0)
            {
                AddBulkPoints(PointsSnapshot, bulk);
                Log("Bulk points added: " + bulk);
            }
            Log("Synthetic points: " + PointsSnapshot.Count);

            ParseBindAddress();
            iedModel = BuildModel(PointsSnapshot);
            ExportManifest();
            CreateServer();

            Active = true; // required for control handlers to accept commands
            StartServer();

            if (iedServer != null && iedServer.IsRunning())
                Log("SELF TEST: server RUNNING on port " + BindPort + " - browse it with an IEC 61850 client.");
            else
            {
                Log("SELF TEST: server FAILED to start.");
                Environment.Exit(-1);
            }

            // simulate a couple of live updates through the normal update path
            int tick = 0;
            var rnd = new Random();
            for (int i = 0; i < 10 && !Shutdown; i++)
            {
                foreach (var kv in MapByTag)
                {
                    var mp = kv.Value;
                    if (mp.isCommand) continue;
                    var pu = new PointUpdate
                    {
                        point = mp,
                        value = mp.kind == PointKind.MV ? rnd.NextDouble() * 100.0 : (tick % 2),
                        valueString = "s" + tick,
                        invalid = false,
                        sourceTime = DateTime.UtcNow,
                        hasSourceTime = true,
                        sourceTimeOk = true
                    };
                    UpdateQueue.Enqueue(pu);
                }
                tick++;
                // drain via the same loop the driver uses
                DrainOnce();
                Thread.Sleep(500);
            }

            // optional 4th arg: seconds to keep serving, for manual browsing with a real client
            int holdSecs = 20;
            if (args.Length > 3 && int.TryParse(args[3], out int hs) && hs > 0) holdSecs = hs;
            Log($"SELF TEST: updates applied without error. Server stays up {holdSecs} s for manual browsing...");
            for (int i = 0; i < holdSecs && !Shutdown; i++) Thread.Sleep(1000);

            StopServer();
            iedServer?.Destroy();
            Log("SELF TEST: done.");
            Environment.Exit(0);
        }

        // Generate a large batch of points in a single topic, mimicking a real substation
        // database, so logical-node sizing can be validated against real MMS clients.
        static void AddBulkPoints(List<rtData> list, int count)
        {
            int id = 10000;
            for (int i = 0; i < count; i++)
            {
                var isAnalog = (i % 3) == 0;
                list.Add(new rtData
                {
                    _id = BsonInt32.Create(id + i),
                    tag = BsonString.Create("BULK_" + (isAnalog ? "AI_" : "DI_") + i),
                    type = BsonString.Create(isAnalog ? "analog" : "digital"),
                    value = BsonDouble.Create(i),
                    valueString = BsonString.Create(""),
                    invalid = BsonBoolean.Create(false),
                    origin = BsonString.Create("supervised"),
                    description = BsonString.Create("bulk point " + i),
                    ungroupedDescription = BsonString.Create("bulk " + i),
                    group1 = BsonString.Create("BULK"),
                    group2 = BsonString.Create(""),
                    group3 = BsonString.Create(""),
                    timeTagAtSourceOk = BsonBoolean.Create(false),
                    protocolSourceConnectionNumber = BsonDouble.Create(999),
                });
            }
        }

        // Regression guard: realtimeData stores protocolSource{ASDU,CommonAddress,ObjectAddress}
        // as numbers when numeric and as strings otherwise (see auth.controller.js updateTag),
        // and this driver reads points from every source driver. Deserialization must tolerate both.
        static bool TestDeserialization()
        {
            var ok = true;

            Action<string, BsonDocument, Func<rtData, bool>> check =
                (name, doc, verify) =>
                {
                    try
                    {
                        var d = MongoDB.Bson.Serialization.BsonSerializer.Deserialize<rtData>(doc);
                        if (verify(d))
                            Log("  OK   " + name, LogLevelBasic);
                        else
                        {
                            Log("  FAIL " + name + " (deserialized, wrong value)", LogLevelBasic);
                            ok = false;
                        }
                    }
                    catch (Exception e)
                    {
                        Log("  FAIL " + name + ": " + e.Message, LogLevelBasic);
                        ok = false;
                    }
                };

            Log("Checking rtData deserialization against mixed BSON types...", LogLevelBasic);

            // the exact shape that crashed against the live database: numeric ASDU/addresses
            check("numeric protocolSource* (IEC 104 style)",
                new BsonDocument {
                    { "_id", 1234.0 },
                    { "tag", "NUMERIC_ASDU_TAG" },
                    { "type", "analog" },
                    { "value", 12.5 },
                    { "protocolSourceASDU", 13.0 },
                    { "protocolSourceCommonAddress", 1.0 },
                    { "protocolSourceObjectAddress", 4001.0 },
                    { "protocolSourceConnectionNumber", 71.0 },
                },
                // routing metadata must survive with its ORIGINAL BSON type, because it is
                // copied verbatim into commandsQueue for the destination driver
                d => d.protocolSourceASDU.IsDouble && d.protocolSourceASDU.ToDouble() == 13.0 &&
                     d.protocolSourceCommonAddress.ToDouble() == 1.0 &&
                     d.protocolSourceObjectAddress.ToDouble() == 4001.0 &&
                     d._id.ToInt32() == 1234);

            check("string protocolSource* (IEC 61850 style)",
                new BsonDocument {
                    { "_id", 5.0 },
                    { "tag", "STRING_ASDU_TAG" },
                    { "type", "digital" },
                    { "protocolSourceASDU", "M_SP_NA_1" },
                    { "protocolSourceCommonAddress", "ST" },
                    { "protocolSourceObjectAddress", "SENSORS/GGIO1.Ind1" },
                },
                d => d.protocolSourceASDU.IsString &&
                     d.protocolSourceASDU.AsString == "M_SP_NA_1" &&
                     d.protocolSourceObjectAddress.AsString == "SENSORS/GGIO1.Ind1");

            check("int32 ASDU + numeric booleans",
                new BsonDocument {
                    { "_id", 7 },
                    { "tag", "INT_TAG" },
                    { "protocolSourceASDU", 45 },
                    { "invalid", 1 },
                    { "substituted", 0 },
                    { "protocolSourceCommandUseSBO", 1.0 },
                },
                d => d.protocolSourceASDU.IsInt32 && d.protocolSourceASDU.ToInt32() == 45 &&
                     d.invalid.ToBoolean() == true &&
                     d.substituted.ToBoolean() == false &&
                     d.protocolSourceCommandUseSBO.ToBoolean() == true);

            check("nulls and missing fields",
                new BsonDocument {
                    { "_id", 9.0 },
                    { "tag", "NULL_TAG" },
                    { "protocolSourceASDU", BsonNull.Value },
                    { "valueString", BsonNull.Value },
                    { "invalid", BsonNull.Value },
                },
                d => (d.protocolSourceASDU == null || d.protocolSourceASDU.IsBsonNull) &&
                     d.invalid.ToBoolean() == false);

            check("boolean/string coercions",
                new BsonDocument {
                    { "_id", 11.0 },
                    { "tag", "COERCE_TAG" },
                    { "protocolSourceASDU", true },
                    { "invalid", "true" },
                    { "value", "42.5" },
                },
                d => d.protocolSourceASDU.IsBoolean &&
                     d.invalid.ToBoolean() == true &&
                     Math.Abs(d.value.ToDouble() - 42.5) < 1e-9);

            Log(ok ? "rtData deserialization: ALL CHECKS PASSED" : "rtData deserialization: FAILURES", LogLevelBasic);
            return ok;
        }

        static void DrainOnce()
        {
            if (iedServer == null || !iedServer.IsRunning()) return;
            iedServer.LockDataModel();
            try
            {
                while (UpdateQueue.TryDequeue(out var upd))
                    ApplyUpdate(upd);
            }
            finally { iedServer.UnlockDataModel(); }
        }

        static List<rtData> BuildSyntheticPoints()
        {
            var list = new List<rtData>();
            int id = 100;
            Action<string, string, string, string, double, string> add =
                (tag, type, group1, origin, value, valueString) =>
                {
                    list.Add(new rtData
                    {
                        _id = BsonInt32.Create(id++),
                        tag = BsonString.Create(tag),
                        type = BsonString.Create(type),
                        value = BsonDouble.Create(value),
                        valueString = BsonString.Create(valueString),
                        invalid = BsonBoolean.Create(false),
                        substituted = BsonBoolean.Create(false),
                        overflow = BsonBoolean.Create(false),
                        transient = BsonBoolean.Create(false),
                        origin = BsonString.Create(origin),
                        description = BsonString.Create(tag + " description"),
                        ungroupedDescription = BsonString.Create(tag),
                        group1 = BsonString.Create(group1),
                        group2 = BsonString.Create(""),
                        group3 = BsonString.Create(""),
                        timeTagAtSourceOk = BsonBoolean.Create(false),
                        protocolSourceASDU = BsonString.Create(""),
                        protocolSourceCommonAddress = BsonString.Create("1"),
                        protocolSourceConnectionNumber = BsonDouble.Create(999),
                        protocolSourceObjectAddress = BsonString.Create((id).ToString()),
                        protocolSourceCommandDuration = BsonDouble.Create(0),
                        protocolSourceCommandUseSBO = BsonBoolean.Create(false)
                    });
                };

            add("KAW2_DJ_52-1_STATUS", "digital", "KAW2", "supervised", 1, "");
            add("KAW2_DJ_52-2_STATUS", "digital", "KAW2", "supervised", 0, "");
            add("KAW2_MW_TOTAL", "analog", "KAW2", "supervised", 42.5, "");
            add("KAW2_KV_BUS", "analog", "KAW2", "supervised", 138.2, "");
            add("KAW2_NOTE", "string", "KAW2", "supervised", 0, "OK");
            add("KAW2_DJ_52-1_CMD", "digital", "KAW2", "command", 0, "");
            add("KAW2_TAP_SETPOINT", "analog", "KAW2", "command", 0, "");
            add("KIK3_DJ_52-1_STATUS", "digital", "KIK3", "supervised", 1, "");
            add("KIK3_MW_TOTAL", "analog", "KIK3", "supervised", 17.0, "");

            return list;
        }
    }
}
