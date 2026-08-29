/*
 * OPC-UA Client Protocol driver for {json:scada}, in Go.
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
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

// Acquired-value queue and the MongoDB writer. Port of MongoUpdate.cs.
//
// Only sourceDataUpdate is written for data; the tag value, alarms and
// history are all derived by cs_data_processor.

package main

import (
	"context"
	"encoding/json"
	"strconv"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/writeconcern"
)

// dataQueue holds acquired values until the writer flushes them. It stands
// in for the C# ConcurrentQueue<OPC_Value>.
var dataQueue struct {
	mu    sync.Mutex
	items []OPCValue
}

// enqueueValue queues one acquired value. Called from the notification
// pump, so it must never block.
func enqueueValue(ov OPCValue) {
	dataQueue.mu.Lock()
	dataQueue.items = append(dataQueue.items, ov)
	dataQueue.mu.Unlock()
}

func queueLen() int {
	dataQueue.mu.Lock()
	defer dataQueue.mu.Unlock()
	return len(dataQueue.items)
}

func dequeueValue() (OPCValue, bool) {
	dataQueue.mu.Lock()
	defer dataQueue.mu.Unlock()
	if len(dataQueue.items) == 0 {
		return OPCValue{}, false
	}
	ov := dataQueue.items[0]
	dataQueue.items = dataQueue.items[1:]
	return ov, true
}

// mongoUpdateLoop drains the acquired-value queue into realtimeData,
// inserting tags discovered by autoCreateTags along the way.
func mongoUpdateLoop(ctx context.Context, cfg JSONSCADAConfig, conns []*OPCUAConnection) {
	for ctx.Err() == nil {
		cli, err := mongoConnect(cfg)
		if err != nil {
			Log(LogLevelNoLog, "Exception Mongo")
			Log(LogLevelNoLog, "%v", err)
			time.Sleep(1 * time.Second)
			continue
		}
		db := cli.Database(cfg.MongoDatabaseName)

		// parity: the C# driver writes with an unacknowledged write
		// concern, trading durability for throughput on a stream that is
		// refreshed continuously anyway.
		collRTD := db.Collection(RealtimeDataCollectionName,
			options.Collection().SetWriteConcern(writeconcern.Unacknowledged()))

		Log(LogLevelNoLog, "MongoDB Update Thread Started...")

		err = updateCycle(ctx, collRTD, conns)
		if err != nil && ctx.Err() == nil {
			Log(LogLevelNoLog, "Exception Mongo")
			Log(LogLevelNoLog, "%v", err)
			time.Sleep(1 * time.Second)
		}
		_ = cli.Disconnect(context.Background())
	}
}

func updateCycle(ctx context.Context, collRTD *mongo.Collection, conns []*OPCUAConnection) error {
	var writes []mongo.WriteModel

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		start := time.Now()
		writes = writes[:0]

		for {
			ov, ok := dequeueValue()
			if !ok {
				break
			}

			if ov.SelfPublish {
				writes = append(writes, maybeInsertTag(ctx, collRTD, conns, &ov)...)
			}
			if m := updateModel(ov); m != nil {
				writes = append(writes, m)
			}

			if len(writes) >= BulkWriteLimit {
				break
			}
			if time.Since(start) > 750*time.Millisecond {
				Log(LogLevelBasic, "break ms %d", time.Since(start).Milliseconds())
				break
			}
		}

		if len(writes) > 0 {
			flushStart := time.Now()
			Log(LogLevelBasic, "MongoDB - Bulk writing %d, Total enqueued data %d", len(writes), queueLen())
			_, err := collRTD.BulkWrite(ctx, writes,
				options.BulkWrite().SetOrdered(false).SetBypassDocumentValidation(true))
			if err != nil {
				Log(LogLevelNoLog, "MongoDB - Bulk write error - %v", err)
			} else {
				ms := time.Since(flushStart).Milliseconds()
				ups := 0
				if ms > 0 {
					ups = int(float64(len(writes)) / (float64(ms) / 1000))
				}
				Log(LogLevelBasic, "MongoDB - Bulk written %d documents in %d ms, updates per second: %d",
					len(writes), ms, ups)
			}
		}

		if queueLen() == 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(200 * time.Millisecond):
			}
		}
	}
}

// updateModel builds the sourceDataUpdate write for one acquired value.
func updateModel(ov OPCValue) mongo.WriteModel {
	var srcTime any
	if ov.HasSourceTimestamp {
		srcTime = bson.NewDateTimeFromTime(ov.SourceTimestamp)
	}

	var valBSON any
	if ov.ValueJSON != "" {
		if err := json.Unmarshal([]byte(ov.ValueJSON), &valBSON); err != nil {
			Log(LogLevelBasic, "%s - %v", ov.ConnName, err)
			valBSON = nil
		}
	}

	update := bson.M{"$set": bson.M{"sourceDataUpdate": bson.M{
		"valueBsonAtSource":           valBSON,
		"valueJsonAtSource":           ov.ValueJSON,
		"valueAtSource":               ov.Value,
		"valueStringAtSource":         ov.ValueString,
		"asduAtSource":                ov.Asdu,
		"causeOfTransmissionAtSource": strconv.Itoa(ov.Cot),
		"timeTagAtSource":             srcTime,
		"timeTagAtSourceOk":           ov.HasSourceTimestamp,
		"timeTag":                     bson.NewDateTimeFromTime(ov.ServerTimestamp),
		"notTopicalAtSource":          false,
		"invalidAtSource":             !ov.Quality,
		"overflowAtSource":            false,
		"blockedAtSource":             false,
		"substitutedAtSource":         false,
	}}}

	// parity: a value too large to store is dropped rather than failing the
	// whole bulk write. The C# test is the rendered lengths *and* the
	// encoded size, so a merely long string still gets through.
	if len(ov.ValueJSON)+len(ov.ValueString) > 1000000 {
		if raw, err := bson.Marshal(update); err == nil && len(raw) > 16000000 {
			Log(LogLevelDetailed,
				"MongoDB - Too big update for %s - %d bytes, will not be written to MongoDB",
				ov.Address, len(raw))
			return nil
		}
	}

	// The origin filter keeps a supervised point from being updated by the
	// command tag that shares its object address.
	filter := bson.M{
		"protocolSourceConnectionNumber": float64(ov.ConnNumber),
		"protocolSourceObjectAddress":    ov.Address,
		"origin":                         "supervised",
	}

	Log(LogLevelDebug, "MongoDB - ADD %s %v", ov.Address, ov.Value)

	return mongo.NewUpdateOneModel().SetFilter(filter).SetUpdate(update)
}

// maybeInsertTag creates the tag of a point the driver discovered itself,
// plus its command twin when the variable is writable. Returns the inserts
// to add to the bulk write, which is empty for a point that already has a
// tag.
func maybeInsertTag(ctx context.Context, collRTD *mongo.Collection, conns []*OPCUAConnection, ov *OPCValue) []mongo.WriteModel {
	conn := connByNumber(conns, ov.ConnNumber)
	if conn == nil {
		// parity: an unknown connection number must not fall back to the
		// first connection, which would create the tag under the wrong one.
		Log(LogLevelDetailed, "%s - Connection number not found for address %s, skipping tag insert",
			ov.ConnName, ov.Address)
		return nil
	}

	if !conn.AddInsertedAddress(ov.Address) {
		return nil // already in realtimeData
	}

	tag := tagFromOPCParameters(*ov)
	Log(LogLevelDetailed, "%s - INSERT NEW TAG: %s - Addr:%s", ov.ConnName, tag, ov.Address)

	key := nextTagKey(ctx, collRTD, conn, ov.ConnNumber)

	// A value that arrived through a notification carries no browse path;
	// fill it in from what browsing recorded.
	if details, ok := conn.NodeDetailsFor(ov.Address); ok {
		ov.ParentName = details.ParentName
		ov.Path = details.Path
	} else {
		ov.ParentName = ""
		ov.Path = ""
		Log(LogLevelDetailed, "%s - NodeId not found in NodeIdsDetails: %s", ov.ConnName, ov.Address)
	}

	var writes []mongo.WriteModel

	// The command twin is inserted first so the supervised tag can point at
	// it, and it points back at the supervised key that follows it.
	commandOfSupervised := 0.0
	if conn.CommandsEnabled && ov.CreateCommandForSupervised {
		cmdDoc := newRealtimeDoc(*ov, key, 0)
		cmdDoc["protocolSourcePublishingInterval"] = 0.0
		cmdDoc["protocolSourceSamplingInterval"] = 0.0
		cmdDoc["protocolSourceQueueSize"] = 0.0
		writes = append(writes, mongo.NewInsertOneModel().SetDocument(cmdDoc))

		commandOfSupervised = key
		key = conn.BumpTagKey()
	}

	ov.CreateCommandForSupervised = false
	doc := newRealtimeDoc(*ov, key, commandOfSupervised)
	doc["protocolSourcePublishingInterval"] = conn.AutoCreateTagPublishingInterval
	doc["protocolSourceSamplingInterval"] = conn.AutoCreateTagSamplingInterval
	doc["protocolSourceQueueSize"] = conn.AutoCreateTagQueueSize
	writes = append(writes, mongo.NewInsertOneModel().SetDocument(doc))

	return writes
}

// nextTagKey allocates the _id of a new tag inside the range reserved for
// its connection. The first call looks up the highest key already used.
func nextTagKey(ctx context.Context, collRTD *mongo.Collection, conn *OPCUAConnection, connNumber int) float64 {
	if conn.TagKeyStarted() {
		return conn.BumpTagKey()
	}

	base := float64(connNumber) * AutoKeyMultiplier
	last := base

	findCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.M
	err := collRTD.FindOne(findCtx,
		bson.M{"_id": bson.M{"$gt": base, "$lt": float64(connNumber+1) * AutoKeyMultiplier}},
		options.FindOne().SetSort(bson.M{"_id": -1}),
	).Decode(&doc)
	if err == nil {
		last = mFloat(doc, "_id", base) + 1
	}

	conn.SetTagKey(last)
	return last
}
