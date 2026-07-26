/*
 * IEC 61850 Server (IEC61850-90-2 gateway/proxy) protocol driver for {json:scada}.
 * Exposes the JSON-SCADA realtimeData points (filtered by group1 via the connection
 * topics list) as an IEC 61850 MMS server, mirroring the behavior of the OPC server drivers.
 *
 * {json:scada} - Copyright (c) 2020-2024 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * Requires libiec61850 from MZ Automation.
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

using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Threading;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Bson.Serialization.Serializers;
using MongoDB.Driver;
using IEC61850.Server;
using IEC61850.Common;

namespace IEC61850_Server
{
    partial class MainClass
    {
        public static string JsonConfigFilePath = @"../conf/json-scada.json";
        public static string JsonConfigFilePathAlt = @"c:/json-scada/conf/json-scada.json";
        public static int LogLevelNoLog = 0; // log level 0=no
        public static int LogLevelBasic = 1; // log level 1=basic (default)
        public static int LogLevelDetailed = 2; // log level 2=detailed
        public static int LogLevelDebug = 3; // log level 3=debug
        public static int LogLevel = 1;
        private static Mutex LogMutex = new Mutex();

        public static JSONSCADAConfig JSConfig;
        public static protocolDriverInstancesClass DriverInstance = null;
        public static string ProtocolConnectionsCollectionName = "protocolConnections";
        public static string ProtocolDriverInstancesCollectionName = "protocolDriverInstances";
        public static string RealtimeDataCollectionName = "realtimeData";
        public static string CommandsQueueCollectionName = "commandsQueue";
        public static int ProtocolDriverInstanceNumber = 1;

        // indicates this driver instance is the active node at the moment (redundancy)
        public static bool Active = false;

        // the single server connection served by this instance
        public static Iec61850ServerConnection srvConn = null;
        // the running IEC 61850 server (null while inactive/stopped)
        public static IedServer iedServer = null;
        // the dynamically built data model
        public static IedModel iedModel = null;

        // tag -> mapped point (for change-stream driven updates)
        public static ConcurrentDictionary<string, MappedPoint> MapByTag =
            new ConcurrentDictionary<string, MappedPoint>();
        // control object reference -> mapped point (for control handlers)
        public static ConcurrentDictionary<string, MappedPoint> MapByCtlObjRef =
            new ConcurrentDictionary<string, MappedPoint>();

        // queue of point updates coming from the mongodb change stream to be pushed to the server
        public static ConcurrentQueue<PointUpdate> UpdateQueue = new ConcurrentQueue<PointUpdate>();
        // queue of commands received from IEC 61850 clients to be inserted in commandsQueue
        public static ConcurrentQueue<BsonDocument> CommandQueue = new ConcurrentQueue<BsonDocument>();

        public static volatile bool Shutdown = false;

        public class JSONSCADAConfig // base configuration of the system (how to reach mongodb, etc.)
        {
            public string nodeName { get; set; }
            public string mongoConnectionString { get; set; }
            public string mongoDatabaseName { get; set; }
            public string tlsCaPemFile { get; set; }
            public string tlsClientPemFile { get; set; }
            public string tlsClientPfxFile { get; set; }
            public string tlsClientKeyPassword { get; set; }
            public bool tlsAllowInvalidHostnames { get; set; }
            public bool tlsAllowChainErrors { get; set; }
            public bool tlsInsecure { get; set; }
        }

        [BsonIgnoreExtraElements]
        public class Iec61850ServerConnection // protocol connection served by this driver instance
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
            [BsonDefaultValue("0.0.0.0:102")]
            public string ipAddressLocalBind { get; set; }
            public string[] ipAddresses { get; set; }
            public string[] topics { get; set; }
            [BsonDefaultValue(true)]
            public bool serverModeMultiActive { get; set; }
            [BsonDefaultValue(1.0)]
            public double maxClientConnections { get; set; }
            [BsonDefaultValue(5000.0)]
            public double maxQueueSize { get; set; }

            // security (IEC 62351-3/-4)
            [BsonDefaultValue(false)]
            public bool useSecurity { get; set; }
            [BsonDefaultValue("")]
            public string localCertFilePath { get; set; }
            [BsonDefaultValue("")]
            public string privateKeyFilePath { get; set; }
            [BsonDefaultValue(new string[] { })]
            public string[] peerCertFilesPaths { get; set; }
            [BsonDefaultValue("")]
            public string rootCertFilePath { get; set; }
            [BsonDefaultValue(false)]
            public bool chainValidation { get; set; }
            [BsonDefaultValue(false)]
            public bool allowOnlySpecificCertificates { get; set; }
            [BsonDefaultValue(false)]
            public bool allowTLSv10 { get; set; }
            [BsonDefaultValue(false)]
            public bool allowTLSv11 { get; set; }
            [BsonDefaultValue(true)]
            public bool allowTLSv12 { get; set; }
            [BsonDefaultValue(true)]
            public bool allowTLSv13 { get; set; }
            [BsonDefaultValue("")]
            public string cipherList { get; set; }

            // ACSE authentication (optional)
            [BsonDefaultValue("")]
            public string username { get; set; }
            [BsonDefaultValue("")]
            public string password { get; set; }
        }

        [BsonIgnoreExtraElements]
        public class protocolDriverInstancesClass
        {
            public ObjectId Id { get; set; }
            public int protocolDriverInstanceNumber { get; set; } = 1;
            public string protocolDriver { get; set; } = "";
            public bool enabled { get; set; } = true;
            public int logLevel { get; set; } = 1;
            public string[] nodeNames { get; set; } = new string[0];
            public string activeNodeName { get; set; } = "";
            public DateTime activeNodeKeepAliveTimeTag { get; set; } = DateTime.MinValue;
            public bool keepProtocolRunningWhileInactive { get; set; } = false;
        }

        // The IEC 61850 CDC kind a point is mapped to (drives value/quality update logic).
        public enum PointKind
        {
            SPS,  // single point status (digital monitor)
            MV,   // measured value float (analog monitor)
            VSS,  // visible string status (string monitor)
            INS,  // integer status (integer monitor)
            SPC,  // single point controllable (digital command)
            DPC,  // double point controllable (double command)
            APC,  // analog setpoint controllable (analog command)
            INC   // integer setpoint controllable (integer command)
        }

        // Association between a JSON-SCADA tag and its IEC 61850 model node.
        public class MappedPoint
        {
            public string tag;
            public PointKind kind;
            public bool isCommand;
            public int pointKey;
            public string objRef;

            // command routing metadata (copied from rtData at model build time).
            // The BsonValue fields keep the source document's original type so commandsQueue
            // entries look exactly like the ones the OPC server drivers produce.
            public double protocolSourceConnectionNumber;
            public BsonValue protocolSourceCommonAddress;
            public BsonValue protocolSourceObjectAddress;
            public BsonValue protocolSourceASDU;
            public double protocolSourceCommandDuration;
            public bool protocolSourceCommandUseSBO;

            // libiec61850 model handles (resolved after model build, before server start)
            public IEC61850.Server.DataObject dobj;
            public IEC61850.Server.DataAttribute daValue;
            public IEC61850.Server.DataAttribute daQ;
            public IEC61850.Server.DataAttribute daT;
        }

        // A pending value update to be pushed to the server data model.
        public struct PointUpdate
        {
            public MappedPoint point;
            public double value;
            public string valueString;
            public bool invalid;
            public bool substituted;
            public bool overflow;
            public bool transient;
            public bool test;
            public DateTime sourceTime;
            public bool hasSourceTime;
            public bool sourceTimeOk;
        }

        [BsonIgnoreExtraElements]
        public class rtData
        {
            [BsonSerializer(typeof(BsonIntSerializer))]
            public BsonInt32 _id { get; set; }
            [BsonSerializer(typeof(BsonStringSerializer))]
            public BsonString tag { get; set; }
            [BsonSerializer(typeof(BsonStringSerializer))]
            public BsonString type { get; set; }
            [BsonSerializer(typeof(BsonDoubleSerializer))]
            public BsonDouble value { get; set; }
            [BsonSerializer(typeof(BsonStringSerializer))]
            public BsonString valueString { get; set; }
            [BsonSerializer(typeof(BsonBooleanSerializer))]
            public BsonBoolean invalid { get; set; }
            [BsonSerializer(typeof(BsonBooleanSerializer))]
            public BsonBoolean substituted { get; set; }
            [BsonSerializer(typeof(BsonBooleanSerializer))]
            public BsonBoolean overflow { get; set; }
            [BsonSerializer(typeof(BsonBooleanSerializer))]
            public BsonBoolean transient { get; set; }
            [BsonSerializer(typeof(BsonStringSerializer))]
            public BsonString origin { get; set; }
            [BsonSerializer(typeof(BsonStringSerializer))]
            public BsonString description { get; set; }
            [BsonSerializer(typeof(BsonStringSerializer))]
            public BsonString ungroupedDescription { get; set; }
            [BsonSerializer(typeof(BsonStringSerializer))]
            public BsonString group1 { get; set; }
            [BsonSerializer(typeof(BsonStringSerializer))]
            public BsonString group2 { get; set; }
            [BsonSerializer(typeof(BsonStringSerializer))]
            public BsonString group3 { get; set; }
            public BsonValue timeTag { get; set; }
            public BsonValue timeTagAtSource { get; set; }
            [BsonSerializer(typeof(BsonBooleanSerializer))]
            public BsonBoolean timeTagAtSourceOk { get; set; }
            // Routing metadata is copied verbatim into commandsQueue, so the original BSON type
            // must be preserved (numeric for IEC 60870-5/DNP3 style sources, string for
            // IEC 61850/OPC style). BsonValue accepts any type and keeps it intact.
            public BsonValue protocolSourceASDU { get; set; }
            public BsonValue protocolSourceCommonAddress { get; set; }
            [BsonSerializer(typeof(BsonDoubleSerializer))]
            public BsonDouble protocolSourceConnectionNumber { get; set; }
            public BsonValue protocolSourceObjectAddress { get; set; }
            [BsonSerializer(typeof(BsonDoubleSerializer))]
            public BsonDouble protocolSourceCommandDuration { get; set; }
            [BsonSerializer(typeof(BsonBooleanSerializer))]
            public BsonBoolean protocolSourceCommandUseSBO { get; set; }
        }

        static void Log(string str, int level = 1)
        {
            if (LogLevel >= level)
            {
                var now = DateTime.Now;
                LogMutex.WaitOne();
                Console.Write($"[{now.ToString("o")}]");
                Console.WriteLine(" " + str);
                LogMutex.ReleaseMutex();
            }
        }

        static void Log(Exception e, int level = 1)
        {
            Log(e.ToString(), level);
        }

        // generic permissive numeric deserializer resulting double (read most types as double, write to double)
        public class BsonDoubleSerializer : SerializerBase<BsonDouble>
        {
            public override void Serialize(BsonSerializationContext context, BsonSerializationArgs args, BsonDouble dval)
            {
                if (dval == null) { dval = BsonDouble.Create(0); }
                context.Writer.WriteDouble(dval.ToDouble());
            }
            public override BsonDouble Deserialize(BsonDeserializationContext context, BsonDeserializationArgs args)
            {
                var type = context.Reader.GetCurrentBsonType();
                var dval = 0.0;
                string s;
                switch (type)
                {
                    case BsonType.Double:
                        return BsonDouble.Create(context.Reader.ReadDouble());
                    case BsonType.Null:
                        context.Reader.ReadNull();
                        break;
                    case BsonType.String:
                        s = context.Reader.ReadString();
                        try { dval = double.Parse(s); } catch (Exception) { }
                        break;
                    case BsonType.ObjectId:
                        s = context.Reader.ReadObjectId().ToString();
                        try { dval = double.Parse(s); } catch (Exception) { }
                        break;
                    case BsonType.JavaScript:
                        s = context.Reader.ReadJavaScript();
                        try { dval = double.Parse(s); } catch (Exception) { }
                        break;
                    case BsonType.Decimal128:
                        dval = Convert.ToDouble(context.Reader.ReadDecimal128());
                        break;
                    case BsonType.Boolean:
                        dval = Convert.ToDouble(context.Reader.ReadBoolean());
                        break;
                    case BsonType.Int32:
                        dval = context.Reader.ReadInt32();
                        break;
                    case BsonType.Int64:
                        dval = context.Reader.ReadInt64();
                        break;
                }
                return BsonDouble.Create(dval);
            }
        }

        // generic permissive deserializer resulting string.
        // Needed because JSON-SCADA stores protocolSource{ASDU,CommonAddress,ObjectAddress} as
        // numbers when the value is numeric (see auth.controller.js updateTag) and as strings
        // otherwise. This driver reads points from every source driver, so it sees both forms.
        public class BsonStringSerializer : SerializerBase<BsonString>
        {
            public override void Serialize(BsonSerializationContext context, BsonSerializationArgs args, BsonString sval)
            {
                context.Writer.WriteString(sval == null ? "" : sval.AsString);
            }
            public override BsonString Deserialize(BsonDeserializationContext context, BsonDeserializationArgs args)
            {
                var type = context.Reader.GetCurrentBsonType();
                var sval = "";
                switch (type)
                {
                    case BsonType.String:
                        return BsonString.Create(context.Reader.ReadString());
                    case BsonType.Null:
                        context.Reader.ReadNull();
                        break;
                    case BsonType.Double:
                        // whole doubles render without a decimal point (13.0 -> "13")
                        sval = context.Reader.ReadDouble().ToString(CultureInfo.InvariantCulture);
                        break;
                    case BsonType.Int32:
                        sval = context.Reader.ReadInt32().ToString(CultureInfo.InvariantCulture);
                        break;
                    case BsonType.Int64:
                        sval = context.Reader.ReadInt64().ToString(CultureInfo.InvariantCulture);
                        break;
                    case BsonType.Decimal128:
                        sval = context.Reader.ReadDecimal128().ToString();
                        break;
                    case BsonType.Boolean:
                        sval = context.Reader.ReadBoolean() ? "true" : "false";
                        break;
                    case BsonType.ObjectId:
                        sval = context.Reader.ReadObjectId().ToString();
                        break;
                    case BsonType.DateTime:
                        sval = BsonUtils.ToDateTimeFromMillisecondsSinceEpoch(
                            context.Reader.ReadDateTime()).ToString("o", CultureInfo.InvariantCulture);
                        break;
                    case BsonType.JavaScript:
                        sval = context.Reader.ReadJavaScript();
                        break;
                    default:
                        context.Reader.SkipValue();
                        break;
                }
                return BsonString.Create(sval);
            }
        }

        // generic permissive deserializer resulting boolean (accepts numeric/string truthy forms)
        public class BsonBooleanSerializer : SerializerBase<BsonBoolean>
        {
            public override void Serialize(BsonSerializationContext context, BsonSerializationArgs args, BsonBoolean bval)
            {
                context.Writer.WriteBoolean(bval != null && bval.AsBoolean);
            }
            public override BsonBoolean Deserialize(BsonDeserializationContext context, BsonDeserializationArgs args)
            {
                var type = context.Reader.GetCurrentBsonType();
                var bval = false;
                switch (type)
                {
                    case BsonType.Boolean:
                        return BsonBoolean.Create(context.Reader.ReadBoolean());
                    case BsonType.Null:
                        context.Reader.ReadNull();
                        break;
                    case BsonType.Double:
                        bval = context.Reader.ReadDouble() != 0.0;
                        break;
                    case BsonType.Int32:
                        bval = context.Reader.ReadInt32() != 0;
                        break;
                    case BsonType.Int64:
                        bval = context.Reader.ReadInt64() != 0;
                        break;
                    case BsonType.String:
                        var s = context.Reader.ReadString();
                        bval = s.Equals("true", StringComparison.OrdinalIgnoreCase) || s == "1";
                        break;
                    default:
                        context.Reader.SkipValue();
                        break;
                }
                return BsonBoolean.Create(bval);
            }
        }

        // generic permissive numeric deserializer resulting int (read most types as int, write to double)
        public class BsonIntSerializer : SerializerBase<BsonInt32>
        {
            public override void Serialize(BsonSerializationContext context, BsonSerializationArgs args, BsonInt32 ival)
            {
                context.Writer.WriteDouble(ival.ToDouble());
            }
            public override BsonInt32 Deserialize(BsonDeserializationContext context, BsonDeserializationArgs args)
            {
                var type = context.Reader.GetCurrentBsonType();
                var dval = 0.0;
                string s;
                switch (type)
                {
                    case BsonType.Int32:
                        return context.Reader.ReadInt32();
                    case BsonType.Int64:
                        dval = context.Reader.ReadInt64();
                        break;
                    case BsonType.Double:
                        dval = context.Reader.ReadDouble();
                        break;
                    case BsonType.Null:
                        context.Reader.ReadNull();
                        break;
                    case BsonType.String:
                        s = context.Reader.ReadString();
                        try { dval = double.Parse(s); } catch (Exception) { }
                        break;
                    case BsonType.ObjectId:
                        s = context.Reader.ReadObjectId().ToString();
                        try { dval = double.Parse(s); } catch (Exception) { }
                        break;
                    case BsonType.JavaScript:
                        s = context.Reader.ReadJavaScript();
                        try { dval = double.Parse(s); } catch (Exception) { }
                        break;
                    case BsonType.Decimal128:
                        dval = Convert.ToDouble(context.Reader.ReadDecimal128());
                        break;
                    case BsonType.Boolean:
                        dval = Convert.ToDouble(context.Reader.ReadBoolean());
                        break;
                }
                return Convert.ToInt32(dval);
            }
        }

        static byte[] GetBytesFromPEM(string pemString, string section)
        {
            var header = string.Format("-----BEGIN {0}-----", section);
            var footer = string.Format("-----END {0}-----", section);
            var start = pemString.IndexOf(header, StringComparison.Ordinal);
            if (start < 0)
                return null;
            start += header.Length;
            var end = pemString.IndexOf(footer, start, StringComparison.Ordinal) - start;
            if (end < 0)
                return null;
            return Convert.FromBase64String(pemString.Substring(start, end));
        }

        private static bool CertificateValidationCallBack(
           object sender,
           X509Certificate certificate,
           X509Chain chain,
           SslPolicyErrors sslPolicyErrors)
        {
            if (sslPolicyErrors == SslPolicyErrors.None)
                return true;

            if ((sslPolicyErrors & SslPolicyErrors.RemoteCertificateChainErrors) != 0)
            {
                if (chain != null && chain.ChainStatus != null)
                {
                    foreach (X509ChainStatus status in chain.ChainStatus)
                    {
                        if ((certificate.Subject == certificate.Issuer) &&
                                (status.Status == X509ChainStatusFlags.UntrustedRoot))
                            continue;
                        SslPolicyErrors ignoredErrors = SslPolicyErrors.None;
                        if (JSConfig.tlsAllowInvalidHostnames)
                            ignoredErrors |= SslPolicyErrors.RemoteCertificateNameMismatch;
                        if (JSConfig.tlsAllowChainErrors)
                            ignoredErrors |= SslPolicyErrors.RemoteCertificateChainErrors;
                        if ((sslPolicyErrors & ~ignoredErrors) == SslPolicyErrors.None)
                            return true;
                        if (status.Status != X509ChainStatusFlags.NoError)
                            return false;
                    }
                }
                return true;
            }
            return false;
        }

        static MongoClient ConnectMongoClient(JSONSCADAConfig jsConfig)
        {
            MongoClientSettings settings = MongoClientSettings.FromUrl(new MongoUrl(jsConfig.mongoConnectionString));
            if (jsConfig.tlsClientPfxFile != null && jsConfig.tlsClientPfxFile != "")
            {
                var pem = System.IO.File.ReadAllText(jsConfig.tlsCaPemFile);
                byte[] certBuffer = GetBytesFromPEM(pem, "CERTIFICATE");
                var caCert = new X509Certificate2(certBuffer);
                var cliCert = new X509Certificate2(jsConfig.tlsClientPfxFile, jsConfig.tlsClientKeyPassword);
                settings.UseTls = true;
                settings.AllowInsecureTls = true;
                settings.SslSettings = new SslSettings
                {
                    ClientCertificates = new[] { caCert, cliCert },
                    CheckCertificateRevocation = false,
                    ServerCertificateValidationCallback = CertificateValidationCallBack
                };
            }
            return new MongoClient(settings);
        }
    }
}
