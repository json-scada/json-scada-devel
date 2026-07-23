/*
 * PLCTags CIP Ethernet/IP & Modbus TCP Client Protocol driver for {json:scada}
 * {json:scada} - Copyright (c) 2020 - 2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

using libplctag;
using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;
using System.Collections.Generic;
using Tag = libplctag.Tag;

namespace PLCTagDriver
{
    partial class MainClass
    {
        public static String ProtocolDriverName = "PLCTAG";
        public static String DriverVersion = "0.2.0";
        public static bool Active = false; // indicates this driver instance is the active node in the moment
        public static Int32 DataBufferLimit = 10000; // limit to start dequeuing and discarding data from the acquisition buffer

        public enum PlcDataType
        {
            Bool,
            Sint,
            Int,
            Dint,
            Lint,
            Real,
            Lreal
        }

        public class ScanTag // a PLC tag to scan plus metadata to decode its value(s)
        {
            public Tag Tag;
            public PlcDataType Type;
            public string TypeName; // asdu type name reported to the database
            public bool IsArray;
            public int ArrayLength;
        }

        [BsonIgnoreExtraElements]
        public class
        PLC_connection // connection to PLC
        {
            public ObjectId Id { get; set; }
            [BsonDefaultValue("")]
            public string protocolDriver { get; set; }
            [BsonDefaultValue(1)]
            public int protocolDriverInstanceNumber { get; set; }
            [BsonDefaultValue(1)]
            public int protocolConnectionNumber { get; set; }
            [BsonDefaultValue("NO NAME")]
            public string name { get; set; }
            [BsonDefaultValue("SERVER NOT DESCRIPTED")]
            public string description { get; set; }
            [BsonDefaultValue(true)]
            public bool enabled { get; set; }
            [BsonDefaultValue(true)]
            public bool commandsEnabled { get; set; }
            [BsonDefaultValue("")]
            public string ipAddressLocalBind { get; set; }
            public string[] ipAddresses { get; set; }
            [BsonDefaultValue(1)]
            public int localLinkAddress { get; set; }
            [BsonDefaultValue(1)]
            public int remoteLinkAddress { get; set; }
            [BsonDefaultValue(300)]
            public int giInterval { get; set; }
            [BsonDefaultValue(1000)]
            public int MaxQueueSize { get; set; }

            [BsonDefaultValue("controllogix")]
            public string plc { get; set; }
            [BsonDefaultValue("ab_eip")]
            public string protocol { get; set; }
            [BsonDefaultValue(true)]
            public bool useConnectedMsg { get; set; }
            [BsonDefaultValue(100)]
            public int readCacheMs { get; set; }
            [BsonDefaultValue(1000)]
            public int timeoutMs { get; set; }
            // byte order overrides, only applied when explicitly configured (empty = libplctag protocol default)
            [BsonDefaultValue("")]
            public string int16ByteOrder { get; set; }
            [BsonDefaultValue("")]
            public string int32ByteOrder { get; set; }
            [BsonDefaultValue("")]
            public string int64ByteOrder { get; set; }
            [BsonDefaultValue("")]
            public string float32ByteOrder { get; set; }
            [BsonDefaultValue("")]
            public string float64ByteOrder { get; set; }

            public List<ScanTag> listTags = new List<ScanTag>();
        }


        [BsonIgnoreExtraElements]
        public class rtData
        {
            [BsonSerializer(typeof(BsonIntSerializer))]
            public BsonInt32 _id { get; set; }
            [BsonDefaultValue("")]
            public BsonString tag { get; set; }
            [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0)]
            public BsonDouble value { get; set; }
            [BsonDefaultValue("")]
            public BsonString valueString { get; set; }
            [BsonDefaultValue(false)]
            public BsonDateTime timeTag { get; set; }
            [BsonDefaultValue(null)]
            public BsonDateTime timeTagAtSource { get; set; }
            [BsonDefaultValue(false)]
            public BsonBoolean timeTagAtSourceOk { get; set; }
            [BsonDefaultValue(false)]
            public BsonBoolean invalid { get; set; }
            [BsonDefaultValue(false)]
            public BsonBoolean transient { get; set; }
            [BsonDefaultValue(false)]
            public BsonBoolean substituted { get; set; }
            [BsonDefaultValue(false)]
            public BsonBoolean overflow { get; set; }
            [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0)]
            public BsonDouble protocolSourceConnectionNumber { get; set; }
            [BsonDefaultValue("")]
            public BsonString protocolSourceCommonAddress { get; set; }
            [BsonDefaultValue("")]
            public  BsonString protocolSourceObjectAddress { get; set; }
            [BsonDefaultValue("")]
            public BsonString protocolSourceASDU { get; set; }
            public BsonDouble protocolSourceCommandDuration { get; set; }
            [BsonDefaultValue(false)]
            public BsonBoolean protocolSourceCommandUseSBO { get; set; }
            [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(1)]
            public BsonDouble kconv1 { get; set; }
            [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0)]
            public BsonDouble kconv2 { get; set; }
            public rtSourceDataUpdate sourceDataUpdate { get; set; }
            public rtDataProtocDest[] protocolDestinations { get; set; }
        }

        static PlcType ParsePlcType(string plc)
        {
            switch (plc.ToLower())
            {
                default:
                case "lgx":
                case "compactlogix":
                case "contrologix":
                case "controllogix":
                    return PlcType.ControlLogix;
                case "pccc":
                case "lgxpccc":
                case "logixpccc":
                    return PlcType.LogixPccc;
                case "omron":
                case "omronnjnx":
                case "omron-njnx":
                case "micro800":
                case "micrologix800":
                case "mlgx800":
                    return PlcType.Micro800;
                case "mlgx":
                case "micrologix":
                    return PlcType.MicroLogix;
                case "plc5":
                    return PlcType.Plc5;
                case "slc500":
                    return PlcType.Slc500;
            }
        }

        static void ParsePlcDataType(string datatype, out PlcDataType type, out int elementSize, out string typeName)
        {
            switch (datatype.ToLower())
            {
                case "bool":
                case "boolean":
                    type = PlcDataType.Bool; elementSize = 1; typeName = "bool";
                    break;
                case "byte":
                case "sint":
                case "int8":
                    type = PlcDataType.Sint; elementSize = 1; typeName = "sint";
                    break;
                default:
                case "int":
                case "int16":
                    type = PlcDataType.Int; elementSize = 2; typeName = "int";
                    break;
                case "dint":
                case "int32":
                    type = PlcDataType.Dint; elementSize = 4; typeName = "dint";
                    break;
                case "lint":
                case "int64":
                    type = PlcDataType.Lint; elementSize = 8; typeName = "lint";
                    break;
                case "real":
                case "float32":
                    type = PlcDataType.Real; elementSize = 4; typeName = "real";
                    break;
                case "lreal":
                case "float64":
                    type = PlcDataType.Lreal; elementSize = 8; typeName = "lreal";
                    break;
            }
        }

        public static void Main(string[] args)
        {
            Log("{json:scada} PLC TAG Driver - Copyright 2020-2026 RLO");
            Log("Driver version " + DriverVersion);
            Log("Using libplctag version " + LibPlcTag.VersionMajor + "."  + LibPlcTag.VersionMinor + "." + LibPlcTag.VersionPatch);

            if (args.Length > 0) // first argument in number of the driver instance
            {
                int num;
                bool res = int.TryParse(args[0], out num);
                if (res) ProtocolDriverInstanceNumber = num;
            }
            if (args.Length > 1) // second argument is logLevel
            {
                int num;
                bool res = int.TryParse(args[1], out num);
                if (res) LogLevel = num;
            }
            string fname = JsonConfigFilePath;
            if (args.Length > 2) // third argument is config file name
            {
                if (File.Exists(args[2]))
                {
                    fname = args[2];
                }
            }
            if (!File.Exists(fname))
                fname = JsonConfigFilePathAlt;
            if (!File.Exists(fname))
            {
                Log("Missing config file " + JsonConfigFilePath);
                Environment.Exit(-1);
            }

            Log("Reading config file " + fname);
            string json = File.ReadAllText(fname);
            JSConfig = JsonSerializer.Deserialize<JSONSCADAConfig>(json);
            if (
                JSConfig.mongoConnectionString == "" ||
                JSConfig.mongoConnectionString == null
            )
            {
                Log("Missing MongoDB connection string in JSON config file " +
                fname);
                Environment.Exit(-1);
            }
            // Log("MongoDB connection string: " + JSConfig.mongoConnectionString);
            if (
                JSConfig.mongoDatabaseName == "" ||
                JSConfig.mongoDatabaseName == null
            )
            {
                Log("Missing MongoDB database name in JSON config file " +
                fname);
                Environment.Exit(-1);
            }
            Log("MongoDB database name: " + JSConfig.mongoDatabaseName);
            if (JSConfig.nodeName == "" || JSConfig.nodeName == null)
            {
                Log("Missing nodeName parameter in JSON config file " +
                fname);
                Environment.Exit(-1);
            }
            Log("Node name: " + JSConfig.nodeName);

            var Client = ConnectMongoClient(JSConfig);
            var DB = Client.GetDatabase(JSConfig.mongoDatabaseName);

            // read and process instances configuration
            var collinsts =
                DB
                    .GetCollection
                    <protocolDriverInstancesClass
                    >(ProtocolDriverInstancesCollectionName);
            var instances =
                collinsts
                    .Find(inst =>
                        inst.protocolDriver == ProtocolDriverName &&
                        inst.protocolDriverInstanceNumber ==
                        ProtocolDriverInstanceNumber &&
                        inst.enabled == true)
                    .ToList();
            var foundInstance = false;
            foreach (protocolDriverInstancesClass inst in instances)
            {
                if (
                    ProtocolDriverName == inst.protocolDriver &&
                    ProtocolDriverInstanceNumber ==
                    inst.protocolDriverInstanceNumber
                )
                {
                    foundInstance = true;
                    if (!inst.enabled)
                    {
                        Log("Driver instance [" +
                        ProtocolDriverInstanceNumber.ToString() +
                        "] disabled!");
                        Environment.Exit(-1);
                    }
                    Log("Instance: " +
                    inst.protocolDriverInstanceNumber.ToString());
                    var nodefound = false || inst.nodeNames.Length == 0;
                    foreach (var name in inst.nodeNames)
                    {
                        if (JSConfig.nodeName == name)
                        {
                            nodefound = true;
                        }
                    }
                    if (!nodefound)
                    {
                        Log("Node '" +
                        JSConfig.nodeName +
                        "' not found in instances configuration!");
                        Environment.Exit(-1);
                    }
                    DriverInstance = inst;
                    break;
                }
                break; // process just first result
            }
            if (!foundInstance)
            {
                Log("Driver instance [" +
                ProtocolDriverInstanceNumber +
                "] not found in configuration!");
                Environment.Exit(-1);
            }

            // read and process connections configuration for this driver instance
            var collconns =
                DB
                    .GetCollection
                    <PLC_connection>(ProtocolConnectionsCollectionName);
            var conns =
                collconns
                    .Find(conn =>
                        conn.protocolDriver == ProtocolDriverName &&
                        conn.protocolDriverInstanceNumber ==
                        ProtocolDriverInstanceNumber &&
                        conn.enabled == true)
                    .ToList();
            foreach (PLC_connection isrv in conns)
            {
                if (isrv.ipAddresses.Length < 1)
                {
                    Log("Missing ipAddresses list!");
                    Environment.Exit(-1);
                }
                PLCconns.Add(isrv);
                Log(isrv.name.ToString() + " - New Connection");
            }
            if (PLCconns.Count == 0)
            {
                Log("No connections found!");
                Environment.Exit(-1);
            }

            switch (LogLevel)
            {
                case LogLevelNoLog:
                    LibPlcTag.DebugLevel = DebugLevel.None;
                    break;
                default:
                case LogLevelBasic:
                    LibPlcTag.DebugLevel = DebugLevel.Warn;
                    break;
                case LogLevelDetailed:
                    LibPlcTag.DebugLevel = DebugLevel.Info;
                    break;
                case LogLevelDebug:
                    LibPlcTag.DebugLevel = DebugLevel.Detail;
                    break;
            }

            // route native libplctag log messages to the driver log
            LibPlcTag.LogEvent += (sender, e) =>
            {
                var level = LogLevelDebug;
                if (e.DebugLevel == DebugLevel.Error || e.DebugLevel == DebugLevel.Warn)
                    level = LogLevelBasic;
                else if (e.DebugLevel == DebugLevel.Info)
                    level = LogLevelDetailed;
                Log("libplctag: " + e.Message, level);
            };

            // start thread to process redundancy control
            Thread thrMongoRedundacy =
                new Thread(() =>
                        ProcessRedundancyMongo(JSConfig));
            thrMongoRedundacy.Start();

            // start thread to update acquired data to database
            Thread thrMongo =
                new Thread(() =>
                        ProcessMongo(JSConfig));
            thrMongo.Start();

            Log("Setting up PLC Connections & tags...");
            foreach (PLC_connection srv in PLCconns)
            {
                var collection = DB.GetCollection<rtData>(RealtimeDataCollectionName);
                var filter = Builders<rtData>.Filter.Eq("protocolSourceConnectionNumber", srv.protocolConnectionNumber);
                var documents = collection.Find(filter).ToList();
                var plctp = ParsePlcType(srv.plc);

                foreach (var document in documents)
                {
                    try
                    {
                        var asdu = document.protocolSourceASDU.ToString();
                        var objAddr = document.protocolSourceObjectAddress.ToString();
                        var isArray = asdu.Contains("[") && asdu.Contains("]");
                        var datatype = asdu;
                        var tagName = objAddr;
                        var arrayLength = 0;
                        if (isArray)
                        {
                            var p1 = asdu.IndexOf("[");
                            var p2 = asdu.IndexOf("]");
                            datatype = asdu.Substring(0, p1);
                            arrayLength = System.Convert.ToInt32(asdu.Substring(p1 + 1, p2 - p1 - 1));
                            var p3 = objAddr.IndexOf("[");
                            if (p3 >= 0) tagName = objAddr.Substring(0, p3);
                        }

                        var tagFound = false; // avoid tag re-insertion (array element points share the same PLC tag)
                        foreach (var tg in srv.listTags)
                        {
                            if (tg.Tag.Name == tagName)
                                tagFound = true;
                        }
                        if (tagFound) continue;

                        ParsePlcDataType(datatype, out var dataType, out var elementSize, out var typeName);

                        var tag = new Tag()
                        {
                            Name = tagName,
                            Gateway = srv.ipAddresses[0],
                            Path = document.protocolSourceCommonAddress.ToString(),
                            PlcType = plctp,
                            Protocol = (srv.protocol.ToLower() == "modbus") ? Protocol.modbus_tcp : Protocol.ab_eip,
                            UseConnectedMessaging = srv.useConnectedMsg,
                            Timeout = TimeSpan.FromMilliseconds(srv.timeoutMs),
                            ReadCacheMillisecondDuration = srv.readCacheMs,
                            ElementSize = elementSize,
                        };
                        if (isArray) // BOOL arrays are packed as 32 bit words
                            tag.ElementCount = dataType == PlcDataType.Bool ? (arrayLength + 31) / 32 : arrayLength;
                        if (!string.IsNullOrEmpty(srv.int16ByteOrder)) tag.Int16ByteOrder = srv.int16ByteOrder;
                        if (!string.IsNullOrEmpty(srv.int32ByteOrder)) tag.Int32ByteOrder = srv.int32ByteOrder;
                        if (!string.IsNullOrEmpty(srv.int64ByteOrder)) tag.Int64ByteOrder = srv.int64ByteOrder;
                        if (!string.IsNullOrEmpty(srv.float32ByteOrder)) tag.Float32ByteOrder = srv.float32ByteOrder;
                        if (!string.IsNullOrEmpty(srv.float64ByteOrder)) tag.Float64ByteOrder = srv.float64ByteOrder;

                        try
                        {
                            tag.Initialize();
                        }
                        catch (LibPlcTagException e)
                        {
                            // keep the tag anyway, it will retry initialization on the next Read() or Write()
                            Log(srv.name + " - Error initializing tag " + tagName + " - Status: " + e.Status);
                        }
                        srv.listTags.Add(new ScanTag()
                        {
                            Tag = tag,
                            Type = dataType,
                            TypeName = typeName,
                            IsArray = isArray,
                            ArrayLength = arrayLength,
                        });
                        Log(srv.name + " - Tag " + tagName + " " + typeName + (isArray ? "[" + arrayLength + "]" : ""), LogLevelDetailed);
                    }
                    catch (Exception e)
                    {
                        Log(srv.name + " - Error creating tag for point " + document.tag + ": " + e.Message);
                    }
                }

                // A thread for scanning each connection
                Thread thrPlcScan =
                    new Thread(() =>
                            ProcessPLCScan(srv));
                thrPlcScan.Start();
            }

            // start thread to watch for commands in the database using a change stream
            Thread thrMongoCmd =
                new Thread(() =>
                        ProcessMongoCmd(JSConfig));
            thrMongoCmd.Start();


            do
            {
                Thread.Sleep(500);

                if (!Console.IsInputRedirected)
                    if (Console.KeyAvailable)
                    {
                        if (Console.ReadKey().Key == ConsoleKey.Escape)
                        {
                            Log("Exiting application!");
                            Environment.Exit(0);
                        }
                        else
                            Log("Press 'Esc' key to terminate...");
                    }
            } while (true);
        }
    }
}
