/* 
 * IEC 60870-5-104 Client Protocol driver for {json:scada}
 * {json:scada} - Copyright (c) 2020 - Ricardo L. Olsen
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
using MongoDB.Bson;
using MongoDB.Driver;

namespace PLCTagDriver
{
    partial class MainClass
    {
        // This process watches (via change stream) for commands inserted to a commands collection
        // When the command is considered valid it is forwarded to the RTU
        static async void ProcessMongoCmd(JSONSCADAConfig jsConfig)
        {
            do
            {
                try
                {
                    var Client = ConnectMongoClient(jsConfig);
                    var DB = Client.GetDatabase(jsConfig.mongoDatabaseName);
                    var collection =
                        DB
                            .GetCollection
                            <rtCommand>(CommandsQueueCollectionName);

                    bool isMongoLive =
                        DB
                            .RunCommandAsync((Command<BsonDocument>)"{ping:1}")
                            .Wait(1000);
                    if (!isMongoLive)
                        throw new Exception("Error on connection " + jsConfig.mongoConnectionString);

                    Log("MongoDB CMD CS - Start listening for commands via changestream...");
                    var filter = "{ operationType: 'insert' }";

                    var pipeline =
                        new EmptyPipelineDefinition<ChangeStreamDocument<rtCommand
                            >
                        >().Match(filter);
                    using (var cursor = await collection.WatchAsync(pipeline))
                    {
                        await cursor
                            .ForEachAsync(async change =>
                            {
                                if (!Active)
                                    return;

                                // process change event, only process inserts
                                if (
                                    change.OperationType ==
                                    ChangeStreamOperationType.Insert
                                )
                                {
                                    // consider only commands for this driver
                                    {
                                        Log("MongoDB CMD CS - Looking for connection " +
                                        change
                                            .FullDocument
                                            .protocolSourceConnectionNumber +
                                        "...");
                                        var found = false;
                                        foreach (PLC_connection
                                            srv
                                            in
                                            PLCconns
                                        )
                                        {
                                            if (
                                                srv.protocolConnectionNumber ==
                                                change
                                                    .FullDocument
                                                    .protocolSourceConnectionNumber
                                            )
                                            {
                                                found = true;
                                                if (
                                                    // srv.connection.IsRunning &&
                                                    srv.commandsEnabled
                                                )
                                                {

                                                ScanTag scanTag = null;
                                                foreach (var st in srv.listTags)
                                                    {
                                                        // commands to array element points are not supported
                                                        if (!st.IsArray && change.FullDocument.protocolSourceObjectAddress == st.Tag.Name)
                                                        {
                                                            scanTag = st;
                                                            break;
                                                        }
                                                    }

                                                if (scanTag != null)
                                                    {
                                                        if (
                                                            DateTime
                                                                .Now
                                                                .ToLocalTime()
                                                                .Subtract(change
                                                                    .FullDocument
                                                                    .timeTag
                                                                    .ToLocalTime(
                                                                    ))
                                                                .TotalSeconds <
                                                            10
                                                        )
                                                        {
                                                            // execute
                                                            var writeOk = true;
                                                            try
                                                            {
                                                                switch (scanTag.Type)
                                                                {
                                                                    case PlcDataType.Bool:
                                                                        scanTag.Tag.SetUInt8(0, change.FullDocument.value != 0 ? (byte)255 : (byte)0);
                                                                        break;
                                                                    case PlcDataType.Sint:
                                                                        scanTag.Tag.SetInt8(0, System.Convert.ToSByte(change.FullDocument.value));
                                                                        break;
                                                                    case PlcDataType.Int:
                                                                        scanTag.Tag.SetInt16(0, System.Convert.ToInt16(change.FullDocument.value));
                                                                        break;
                                                                    case PlcDataType.Dint:
                                                                        scanTag.Tag.SetInt32(0, System.Convert.ToInt32(change.FullDocument.value));
                                                                        break;
                                                                    case PlcDataType.Lint:
                                                                        scanTag.Tag.SetInt64(0, System.Convert.ToInt64(change.FullDocument.value));
                                                                        break;
                                                                    case PlcDataType.Real:
                                                                        scanTag.Tag.SetFloat32(0, System.Convert.ToSingle(change.FullDocument.value));
                                                                        break;
                                                                    case PlcDataType.Lreal:
                                                                        scanTag.Tag.SetFloat64(0, System.Convert.ToDouble(change.FullDocument.value));
                                                                        break;
                                                                }
                                                                await scanTag.Tag.WriteAsync();
                                                            }
                                                            catch (LibPlcTagException e)
                                                            {
                                                                writeOk = false;
                                                                Log("MongoDB CMD CS - " +
                                                                srv.name +
                                                                " - Error writing tag " +
                                                                scanTag.Tag.Name +
                                                                " - Status: " + e.Status);
                                                            }
                                                            catch (Exception e)
                                                            {
                                                                writeOk = false;
                                                                Log("MongoDB CMD CS - " +
                                                                srv.name +
                                                                " - Error writing tag " +
                                                                scanTag.Tag.Name);
                                                                Log(e);
                                                            }

                                                            if (writeOk)
                                                            {
                                                                Log("MongoDB CMD CS - " +
                                                                srv.name +
                                                                " - " +
                                                                " OA " +
                                                                change
                                                                    .FullDocument
                                                                    .protocolSourceObjectAddress +
                                                                " Delivered");

                                                                // update as delivered
                                                                var filter =
                                                                    new BsonDocument(new BsonDocument("_id",
                                                                            change
                                                                                .FullDocument
                                                                                .id));
                                                                var update =
                                                                    new BsonDocument("$set",
                                                                        new BsonDocument("delivered",
                                                                            true));
                                                                var result =
                                                                    await collection
                                                                        .UpdateOneAsync(filter,
                                                                        update);
                                                            }
                                                            else
                                                            {
                                                                // update as canceled (write error)
                                                                var filter =
                                                                    new BsonDocument(new BsonDocument("_id",
                                                                            change
                                                                                .FullDocument
                                                                                .id));
                                                                var update =
                                                                    new BsonDocument("$set",
                                                                        new BsonDocument("cancelReason",
                                                                            "write error"));
                                                                var result =
                                                                    await collection
                                                                        .UpdateOneAsync(filter,
                                                                        update);
                                                            }
                                                        }
                                                        else
                                                        {
                                                            // update as expired
                                                            Log("MongoDB CMD CS - " +
                                                            srv.name +
                                                            " - " +
                                                            " OA " +
                                                            change
                                                                .FullDocument
                                                                .protocolSourceObjectAddress +
                                                            " value " +
                                                            change
                                                                .FullDocument
                                                                .value +
                                                            " Expired");
                                                            var filter =
                                                                new BsonDocument(new BsonDocument("_id",
                                                                        change
                                                                            .FullDocument
                                                                            .id));
                                                            var update =
                                                                new BsonDocument("$set",
                                                                    new BsonDocument("cancelReason",
                                                                        "expired"));
                                                            var result =
                                                                await collection
                                                                    .UpdateOneAsync(filter,
                                                                    update);
                                                        }
                                                    }
                                                    else
                                                    {
                                                        // update as canceled (asdu not implemented)
                                                        Log("MongoDB CMD CS - " +
                                                        srv.name +
                                                        " - " +
                                                        " OA " +
                                                        change
                                                            .FullDocument
                                                            .protocolSourceObjectAddress +
                                                        " value " +
                                                        change
                                                            .FullDocument
                                                            .value +
                                                        " ASDU Not Implemented");
                                                        var filter =
                                                            new BsonDocument(new BsonDocument("_id",
                                                                    change
                                                                        .FullDocument
                                                                        .id));
                                                        var update =
                                                            new BsonDocument("$set",
                                                                new BsonDocument("cancelReason",
                                                                    "asdu not implemented"));
                                                        var result =
                                                            await collection
                                                                .UpdateOneAsync(filter,
                                                                update);
                                                    }
                                                }
                                                else
                                                {
                                                    // update as canceled (not connected)
                                                    Log("MongoDB CMD CS - " +
                                                    srv.name +
                                                    " OA " +
                                                    change
                                                        .FullDocument
                                                        .protocolSourceObjectAddress +
                                                    " value " +
                                                    change.FullDocument.value +
                                                    (
                                                    srv.commandsEnabled
                                                        ? " Not Connected"
                                                        : " Commands Disabled"
                                                    ));
                                                    var filter =
                                                        new BsonDocument(new BsonDocument("_id",
                                                                change
                                                                    .FullDocument
                                                                    .id));
                                                    var update =
                                                        new BsonDocument("$set",
                                                            new BsonDocument("cancelReason",
                                                                (
                                                                srv
                                                                    .commandsEnabled
                                                                    ? "not connected"
                                                                    : "commands disabled"
                                                                )));
                                                    var result =
                                                        await collection
                                                            .UpdateOneAsync(filter,
                                                            update);
                                                }
                                                break;
                                            }
                                        }
                                        if (!found)
                                        {
                                            // update as canceled command (not found)
                                            Log("MongoDB CMD CS - " +
                                            change
                                                .FullDocument
                                                .protocolSourceConnectionNumber
                                                .ToString() +
                                            " OA " +
                                            change
                                                .FullDocument
                                                .protocolSourceObjectAddress +
                                            " value " +
                                            change.FullDocument.value +
                                            " Not Found");
                                            var filter =
                                                new BsonDocument(new BsonDocument("_id",
                                                        change
                                                            .FullDocument
                                                            .id));
                                            var update =
                                                new BsonDocument("$set",
                                                    new BsonDocument("cancelReason",
                                                        "connection not found"));
                                            var result =
                                                await collection
                                                    .UpdateOneAsync(filter,
                                                    update);
                                        }
                                    }
                                }
                            });
                    }
                }
                catch (Exception e)
                {
                    Log("Exception MongoCmd");
                    Log(e);
                    Log(e
                        .ToString()
                        .Substring(0,
                        e.ToString().IndexOf(Environment.NewLine)));
                    System.Threading.Thread.Sleep(3000);
                }
            }
            while (true);
        }
    }
}