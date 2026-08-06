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

// Redundancy control. Port of Redundancy.cs: exactly one node of an
// instance acquires data at a time; the standby takes over when the active
// node stops refreshing its keep-alive.

package main

import (
	"context"
	"math/rand"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const countKeepAliveUpdatesLimit = 4

// redundancyLoop arbitrates the active node and publishes per-connection
// statistics while active.
func redundancyLoop(ctx context.Context, cfg JSONSCADAConfig, conns []*Iec61850Connection) {
	for ctx.Err() == nil {
		cli, err := mongoConnect(cfg)
		if err != nil {
			Log(LogLevelNoLog, "Exception Mongo")
			Log(LogLevelNoLog, "%v", err)
			time.Sleep(3 * time.Second)
			continue
		}
		db := cli.Database(cfg.MongoDatabaseName)
		if err := redundancyCycle(ctx, db, cfg, conns); err != nil && ctx.Err() == nil {
			Log(LogLevelNoLog, "Exception Mongo")
			Log(LogLevelNoLog, "%v", err)
			time.Sleep(3 * time.Second)
		}
		_ = cli.Disconnect(context.Background())
	}
}

func redundancyCycle(ctx context.Context, db *mongo.Database, cfg JSONSCADAConfig, conns []*Iec61850Connection) error {
	var lastActiveNodeKeepAliveTimeTag time.Time
	countKeepAliveUpdates := 0

	collInsts := db.Collection(ProtocolDriverInstancesCollectionName)
	collConns := db.Collection(ProtocolConnectionsCollectionName)

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err := mongoPing(db, 1*time.Second); err != nil {
			return err
		}

		findCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		var doc bson.M
		err := collInsts.FindOne(findCtx, bson.M{
			"protocolDriver":               ProtocolDriverName,
			"protocolDriverInstanceNumber": instanceNumber,
		}).Decode(&doc)
		cancel()

		if err != nil {
			if active.Load() {
				Log(LogLevelNoLog, "Redundancy - DEACTIVATING this Node (no instance found)!")
				countKeepAliveUpdates = 0
				time.Sleep(time.Duration(1000+rand.Intn(4000)) * time.Millisecond)
			}
			active.Store(false)
		} else {
			inst := instanceFromDoc(doc)
			if !nodeAllowed(inst, cfg.NodeName) {
				Fatal("Node '%s' not found in instances configuration!", cfg.NodeName)
			}

			if inst.ActiveNodeName == cfg.NodeName {
				if !active.Load() {
					Log(LogLevelNoLog, "Redundancy - ACTIVATING this Node!")
				}
				active.Store(true)
				countKeepAliveUpdates = 0
			} else {
				if active.Load() {
					Log(LogLevelNoLog, "Redundancy - DEACTIVATING this Node (other node active)!")
					countKeepAliveUpdates = 0
					time.Sleep(time.Duration(1000+rand.Intn(4000)) * time.Millisecond)
				}
				active.Store(false)
				if lastActiveNodeKeepAliveTimeTag.Equal(inst.ActiveNodeKeepAliveTimeTag) {
					countKeepAliveUpdates++
				}
				lastActiveNodeKeepAliveTimeTag = inst.ActiveNodeKeepAliveTimeTag
				if countKeepAliveUpdates > countKeepAliveUpdatesLimit {
					Log(LogLevelNoLog, "Redundancy - ACTIVATING this Node!")
					active.Store(true)
				}
			}

			if active.Load() {
				Log(LogLevelNoLog, "Redundancy - This node is active.")
				updCtx, cancelUpd := context.WithTimeout(ctx, 10*time.Second)
				_, err := collInsts.UpdateOne(updCtx,
					bson.M{
						"protocolDriver":               ProtocolDriverName,
						"protocolDriverInstanceNumber": instanceNumber,
					},
					bson.M{"$set": bson.M{
						"activeNodeName":             cfg.NodeName,
						"activeNodeKeepAliveTimeTag": bson.NewDateTimeFromTime(time.Now()),
					}})
				if err != nil {
					Log(LogLevelDetailed, "Redundancy - %v", err)
				}
				updateConnectionStats(updCtx, collConns, cfg, conns)
				cancelUpd()
			} else {
				if inst.ActiveNodeName != "" {
					Log(LogLevelNoLog, "Redundancy - This node is INACTIVE! Node '%s' is active, wait...", inst.ActiveNodeName)
				} else {
					Log(LogLevelNoLog, "Redundancy - This node is INACTIVE! No node is active, wait...")
				}
			}
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
}

// updateConnectionStats publishes the last seen buffered-report EntryIDs
// and a heartbeat on each connection document. The EntryIDs are read back
// at startup so buffered reports resume where they stopped.
func updateConnectionStats(ctx context.Context, collConns *mongo.Collection, cfg JSONSCADAConfig, conns []*Iec61850Connection) {
	for _, conn := range conns {
		if conn.Client() == nil {
			continue
		}
		ids := bson.M{}
		for k, v := range conn.SnapshotReportIDs() {
			ids[k] = bson.Binary{Subtype: 0, Data: v}
		}
		_, err := collConns.UpdateOne(ctx,
			bson.M{"protocolConnectionNumber": conn.ProtocolConnectionNumber},
			bson.M{"$set": bson.M{
				"lastReportIds": ids,
				"stats": bson.M{
					"nodeName": cfg.NodeName,
					"timeTag":  bson.NewDateTimeFromTime(time.Now()),
				},
			}})
		if err != nil {
			Log(LogLevelDetailed, "Redundancy - stats update: %v", err)
		}
	}
}
