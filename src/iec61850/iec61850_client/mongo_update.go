/*
 * IEC 61850 MMS Client driver for {json:scada}, in Go.
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
)

// dataQueue holds acquired values until the writer flushes them.
var dataQueue struct {
	mu    sync.Mutex
	items []IECValue
}

// enqueueValue queues one acquired value. Called from report callbacks, so
// it must not block.
func enqueueValue(iv IECValue) {
	dataQueue.mu.Lock()
	dataQueue.items = append(dataQueue.items, iv)
	dataQueue.mu.Unlock()
}

func queueLen() int {
	dataQueue.mu.Lock()
	defer dataQueue.mu.Unlock()
	return len(dataQueue.items)
}

// dequeueValue removes the oldest queued value.
func dequeueValue() (IECValue, bool) {
	dataQueue.mu.Lock()
	defer dataQueue.mu.Unlock()
	if len(dataQueue.items) == 0 {
		return IECValue{}, false
	}
	iv := dataQueue.items[0]
	dataQueue.items = dataQueue.items[1:]
	return iv, true
}

// trimQueue discards the oldest values when the database is unreachable and
// the queue outgrows its limit.
func trimQueue(limit int) {
	dataQueue.mu.Lock()
	for len(dataQueue.items) > limit {
		dataQueue.items = dataQueue.items[1:]
		Log(LogLevelDetailed, "MongoDB - Dequeue Data")
	}
	dataQueue.mu.Unlock()
}

// mongoUpdateLoop drains the acquired-value queue into realtimeData,
// inserting tags discovered by autoCreateTags along the way.
func mongoUpdateLoop(ctx context.Context, cfg JSONSCADAConfig, conns []*Iec61850Connection) {
	for ctx.Err() == nil {
		cli, err := mongoConnect(cfg)
		if err != nil {
			Log(LogLevelNoLog, "Exception Mongo")
			Log(LogLevelNoLog, "%v", err)
			time.Sleep(1 * time.Second)
			trimQueue(DataBufferLimit)
			continue
		}
		db := cli.Database(cfg.MongoDatabaseName)
		collRTD := db.Collection(RealtimeDataCollectionName)

		Log(LogLevelNoLog, "MongoDB Update Thread Started...")

		err = updateCycle(ctx, db, collRTD, conns)
		if err != nil && ctx.Err() == nil {
			Log(LogLevelNoLog, "Exception Mongo")
			Log(LogLevelNoLog, "%v", err)
			time.Sleep(1 * time.Second)
			trimQueue(DataBufferLimit)
		}
		_ = cli.Disconnect(context.Background())
	}
}

func updateCycle(ctx context.Context, db *mongo.Database, collRTD *mongo.Collection, conns []*Iec61850Connection) error {
	var writes []mongo.WriteModel

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := mongoPing(db, 2500*time.Millisecond); err != nil {
			return err
		}

		start := time.Now()
		writes = writes[:0]

		for {
			iv, ok := dequeueValue()
			if !ok {
				break
			}

			if iv.SelfPublish {
				if insert := maybeInsertTag(ctx, collRTD, conns, iv); insert != nil {
					writes = append(writes, insert)
				}
			}
			writes = append(writes, updateModel(iv))

			if len(writes) >= BulkWriteLimit {
				break
			}
			if time.Since(start) > 400*time.Millisecond {
				break
			}
		}

		if len(writes) > 0 {
			Log(LogLevelBasic, "MongoDB - Bulk writing %d, Total enqueued data %d", len(writes), queueLen())
			res, err := collRTD.BulkWrite(ctx, writes, options.BulkWrite().SetOrdered(false))
			if err != nil {
				return err
			}
			Log(LogLevelBasic, "MongoDB - OK:%t - Inserted:%d - Updated:%d",
				res.Acknowledged, res.InsertedCount, res.ModifiedCount)
		}

		if queueLen() == 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
	}
}

// updateModel builds the sourceDataUpdate write for one acquired value.
//
// parity: the filter carries no functional constraint, so two tags of the
// same connection sharing an object address under different constraints
// update each other — the same limitation the C# driver has.
func updateModel(iv IECValue) mongo.WriteModel {
	var srcTime any
	if iv.HasSourceTimestamp {
		srcTime = bson.NewDateTimeFromTime(iv.SourceTimestamp)
	}

	filter := bson.M{
		"protocolSourceConnectionNumber": float64(iv.ConnNumber),
		"protocolSourceObjectAddress":    iv.Address,
		"origin":                         "supervised",
	}

	update := bson.M{"$set": bson.M{"sourceDataUpdate": bson.M{
		"valueBsonAtSource":           parseValueJSON(iv),
		"valueAtSource":               iv.Value,
		"valueStringAtSource":         iv.ValueString,
		"asduAtSource":                iv.Asdu,
		"causeOfTransmissionAtSource": strconv.Itoa(iv.Cot),
		"timeTagAtSource":             srcTime,
		"timeTagAtSourceOk":           iv.HasSourceTimestamp,
		"timeTag":                     bson.NewDateTimeFromTime(iv.ServerTimestamp),
		"notTopicalAtSource":          false,
		"invalidAtSource":             !iv.Quality,
		"overflowAtSource":            false,
		"blockedAtSource":             false,
		"substitutedAtSource":         false,
		"transientAtSource":           iv.IsTransient,
		"originator":                  ProtocolDriverName + "|" + strconv.Itoa(iv.ConnNumber),
	}}}

	Log(LogLevelDebug, "MongoDB - ADD %s %v", iv.Address, iv.Value)

	return mongo.NewUpdateOneModel().SetFilter(filter).SetUpdate(update)
}

// parseValueJSON wraps the rendered value the way the C# driver does: the
// stored document is { a: <value> }, an artefact of how it parsed the JSON
// fragment. Keep it — the UI reads that shape today.
func parseValueJSON(iv IECValue) bson.M {
	var parsed any
	if err := json.Unmarshal([]byte(iv.ValueJSON), &parsed); err != nil {
		Log(LogLevelBasic, "%s - %v", iv.ConnName, err)
		return bson.M{}
	}
	return bson.M{"a": parsed}
}

// maybeInsertTag inserts a tag discovered in a report when the connection
// has autoCreateTags and the tag is not known yet.
func maybeInsertTag(ctx context.Context, collRTD *mongo.Collection, conns []*Iec61850Connection, iv IECValue) mongo.WriteModel {
	var conn *Iec61850Connection
	for _, c := range conns {
		if c.ProtocolConnectionNumber == iv.ConnNumber {
			conn = c
			break
		}
	}
	if conn == nil {
		return nil
	}

	tag := TagFromParameters(iv)
	if conn.InsertedTags[tag] {
		return nil
	}
	conn.InsertedTags[tag] = true

	Log(LogLevelBasic, "%s - INSERT NEW TAG: %s - Addr:%s", iv.ConnName, tag, iv.Address)

	if conn.LastNewKeyCreated == 0 {
		autoKeyID := float64(iv.ConnNumber) * AutoKeyMultiplier
		conn.LastNewKeyCreated = autoKeyID
		findCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		cur, err := collRTD.Find(findCtx,
			bson.M{"_id": bson.M{
				"$gt": autoKeyID,
				"$lt": float64(iv.ConnNumber+1) * AutoKeyMultiplier,
			}},
			options.Find().SetSort(bson.D{{Key: "_id", Value: -1}}).SetLimit(1))
		if err == nil {
			var docs []bson.M
			if err := cur.All(findCtx, &docs); err == nil && len(docs) > 0 {
				conn.LastNewKeyCreated = mFloat(docs[0], "_id", autoKeyID) + 1
			}
		}
		cancel()
	} else {
		conn.LastNewKeyCreated++
	}

	return mongo.NewInsertOneModel().SetDocument(newRealtimeDoc(iv, conn.LastNewKeyCreated))
}
