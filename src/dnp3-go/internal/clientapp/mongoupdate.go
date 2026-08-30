/*
 * DNP3 Client Protocol driver for {json:scada}, in Go.
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

// Draining the value queue into realtimeData. Port of processMongo().

package clientapp

import (
	"context"
	"math"
	"strconv"
	"time"

	"dnp3-go/internal/jscfg"
	"dnp3-go/internal/mongoutil"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// The window outside which a timestamp is discarded, in milliseconds since the
// epoch: 2001-09-09 to 2033-05-18.
//
// parity: this is the C++ driver's guard against a device reporting a wild
// time. It also silently zeroes any legitimate timestamp outside that window,
// which will matter in 2033 (quirk Q2).
const (
	minSaneTimeMs = 1000000000000
	maxSaneTimeMs = 2000000000000
)

func sanitizeTime(ms int64) int64 {
	if ms < minSaneTimeMs || ms > maxSaneTimeMs {
		return 0
	}
	return ms
}

// mongoUpdateLoop drains the queue into realtimeData for the life of the
// process, reconnecting on failure.
func (e *Engine) mongoUpdateLoop(ctx context.Context) {
	jscfg.Log(jscfg.LogLevelBasic, "processMongo thread started")

	for ctx.Err() == nil {
		cli, err := mongoutil.Connect(e.cfg)
		if err != nil {
			jscfg.Log(jscfg.LogLevelNoLog, "Exception Mongo: %v", err)
			sleepCtx(ctx, 3*time.Second)
			continue
		}
		db := cli.Database(e.cfg.MongoDatabaseName)
		jscfg.Log(jscfg.LogLevelDetailed, "processMongo: Connected to MongoDB")

		e.drainLoop(ctx, db)

		_ = cli.Disconnect(context.Background())
		sleepCtx(ctx, 3*time.Second)
	}
}

// drainLoop writes batches until MongoDB fails or the context ends.
func (e *Engine) drainLoop(ctx context.Context, db *mongo.Database) {
	rtd := db.Collection(jscfg.RealtimeDataCollectionName)

	for ctx.Err() == nil {
		batch := e.queue.Drain()
		if len(batch) == 0 {
			// Only a closed queue drains empty.
			return
		}
		if !mongoutil.IsLive(db) {
			jscfg.Log(jscfg.LogLevelDetailed, "processMongo: MongoDB connection lost, reconnecting...")
			return
		}
		if err := e.writeBatch(ctx, rtd, batch); err != nil {
			jscfg.Log(jscfg.LogLevelNoLog, "Exception Mongo: %v", err)
			return
		}
	}
}

// writeBatch inserts any newly discovered tags and then applies one
// sourceDataUpdate per value.
//
// The inserts go first so that the updates that follow find the documents they
// were created for, which is the ordering the C++ driver relies on too.
func (e *Engine) writeBatch(ctx context.Context, rtd *mongo.Collection, batch []Dnp3Value) error {
	var (
		inserts []any
		writes  []mongo.WriteModel
	)

	for _, iv := range batch {
		if math.IsNaN(iv.Value) || math.IsInf(iv.Value, 0) || iv.Value > 1e100 || iv.Value < -1e100 {
			jscfg.Log(jscfg.LogLevelDetailed, "Mongo: Skipping invalid value addr=%d val=%v",
				iv.Address, iv.Value)
			continue
		}

		conn := e.connByNumber(iv.ConnNumber)
		if conn != nil {
			if docs := autoCreateFor(ctx, conn, rtd, iv); len(docs) > 0 {
				inserts = append(inserts, docs...)
			}
		}

		serverTime := sanitizeTime(iv.ServerTimestamp)
		sourceTime := int64(0)
		if iv.HasSourceTimestamp {
			sourceTime = sanitizeTime(iv.SourceTimestamp)
		}

		jscfg.Log(jscfg.LogLevelDetailed, "Mongo: Writing conn=%d addr=%d group=%d val=%v",
			iv.ConnNumber, iv.Address, iv.BaseGroup, iv.Value)

		filter := bson.M{
			"protocolSourceConnectionNumber": iv.ConnNumber,
			"protocolSourceCommonAddress":    iv.BaseGroup,
			"protocolSourceObjectAddress":    iv.Address,
		}
		update := bson.M{"$set": bson.M{"sourceDataUpdate": bson.M{
			"valueAtSource":               iv.Value,
			"valueStringAtSource":         iv.ValueString,
			"asduAtSource":                strconv.Itoa(iv.Group) + " " + strconv.Itoa(iv.Variation),
			"causeOfTransmissionAtSource": strconv.Itoa(iv.COT),
			"timeTagAtSource":             bson.DateTime(sourceTime),
			"timeTagAtSourceOk":           iv.TimeTagOk,
			"timeTag":                     bson.DateTime(serverTime),
			"notTopicalAtSource":          iv.Quality.NotTopical(),
			"invalidAtSource":             iv.Quality.Invalid(),
			"overflowAtSource":            iv.Quality.Overflow(),
			"blockedAtSource":             iv.Quality.Blocked(),
			"substitutedAtSource":         iv.Quality.Substituted(),
			"carryAtSource":               iv.Quality.Carry(),
			"transientAtSource":           iv.Quality.Transient,
			"originator":                  ProtocolDriverName + "|" + strconv.Itoa(iv.ConnNumber),
		}}}

		writes = append(writes, mongo.NewUpdateOneModel().SetFilter(filter).SetUpdate(update))
	}

	if len(inserts) > 0 {
		tctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		_, err := rtd.InsertMany(tctx, inserts, options.InsertMany().SetOrdered(false))
		cancel()
		if err != nil {
			// A duplicate key here means another node created the tag first,
			// which is not fatal.
			jscfg.Log(jscfg.LogLevelDetailed, "Mongo: insert_many error (possible duplicate): %v", err)
		}
	}
	if len(writes) > 0 {
		tctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		_, err := rtd.BulkWrite(tctx, writes, options.BulkWrite().SetOrdered(false))
		cancel()
		if err != nil {
			return err
		}
	}
	return nil
}

// invalidatePoints marks every point of a connection invalid after its link
// drops. Port of the ChannelListener::OnStateChange handler.
func (e *Engine) invalidatePoints(ctx context.Context, connNumber int, name string) {
	cli, err := mongoutil.Connect(e.cfg)
	if err != nil {
		jscfg.Log(jscfg.LogLevelDetailed, "%s - Failed to invalidate points: %v", name, err)
		return
	}
	defer func() { _ = cli.Disconnect(context.Background()) }()

	tctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	_, err = cli.Database(e.cfg.MongoDatabaseName).
		Collection(jscfg.RealtimeDataCollectionName).
		UpdateMany(tctx,
			bson.M{"protocolSourceConnectionNumber": connNumber},
			bson.M{"$set": bson.M{"invalid": true, "timeTag": mongoutil.Now()}})
	if err != nil {
		jscfg.Log(jscfg.LogLevelDetailed, "%s - Failed to invalidate points: %v", name, err)
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}
