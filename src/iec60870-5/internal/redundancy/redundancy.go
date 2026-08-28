/*
 * IEC 60870-5-101/104 protocol drivers for {json:scada} - redundancy control
 * {json:scada} - Copyright (c) 2020 - 2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * Port of the C# Redundancy.cs: arbitrates the active node of a driver
 * instance via the protocolDriverInstances collection (clients only).
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

package redundancy

import (
	"context"
	"math/rand"
	"os"
	"sync/atomic"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"iec60870-5/internal/jscfg"
	"iec60870-5/internal/model"
	"iec60870-5/internal/mongoutil"
)

const countKeepAliveUpdatesLimit = 4

// Run loops forever arbitrating the active node for this driver instance.
// statsFn (optional) is called on every cycle while active, to update
// per-connection stats in protocolConnections.
func Run(cfg jscfg.Config, driverName string, instanceNumber int, active *atomic.Bool, statsFn func(collConns *mongo.Collection)) {
	for {
		func() {
			defer func() {
				if r := recover(); r != nil {
					jscfg.Logf(jscfg.LogLevelBasic, "Redundancy - panic recovered: %v", r)
				}
			}()
			client, db, err := mongoutil.Connect(cfg)
			if err != nil {
				jscfg.Log(jscfg.LogLevelBasic, "Redundancy - Mongo connection error: "+err.Error())
				time.Sleep(3 * time.Second)
				return
			}
			defer client.Disconnect(context.Background())
			collInsts := db.Collection(mongoutil.ProtocolDriverInstancesCollectionName)
			collConns := db.Collection(mongoutil.ProtocolConnectionsCollectionName)

			var lastActiveNodeKeepAliveTimeTag time.Time
			countKeepAliveUpdates := 0

			for {
				if !mongoutil.PingOK(client) {
					jscfg.Log(jscfg.LogLevelBasic, "Redundancy - Error on MongoDB connection")
					time.Sleep(3 * time.Second)
					return // reconnect
				}

				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				var inst model.DriverInstance
				err := collInsts.FindOne(ctx, bson.M{
					"protocolDriver":               driverName,
					"protocolDriverInstanceNumber": instanceNumber,
				}).Decode(&inst)
				cancel()

				if err != nil {
					if active.Load() { // will go inactive
						jscfg.Log(jscfg.LogLevelBasic, "Redundancy - DEACTIVATING this Node (no instance found)!")
						countKeepAliveUpdates = 0
						time.Sleep(time.Duration(1000+rand.Intn(4000)) * time.Millisecond)
					}
					active.Store(false)
					time.Sleep(5 * time.Second)
					continue
				}

				nodeFound := len(inst.NodeNames) == 0
				for _, name := range inst.NodeNames {
					if cfg.NodeName == name {
						nodeFound = true
					}
				}
				if !nodeFound {
					jscfg.Log(jscfg.LogLevelBasic, "Node '"+cfg.NodeName+"' not found in instances configuration!")
					os.Exit(-1)
				}

				if inst.ActiveNodeName == cfg.NodeName {
					if !active.Load() {
						jscfg.Log(jscfg.LogLevelBasic, "Redundancy - ACTIVATING this Node!")
					}
					active.Store(true)
					countKeepAliveUpdates = 0
				} else {
					if active.Load() { // will go inactive: wait a random time
						jscfg.Log(jscfg.LogLevelBasic, "Redundancy - DEACTIVATING this Node (other node active)!")
						countKeepAliveUpdates = 0
						time.Sleep(time.Duration(1000+rand.Intn(4000)) * time.Millisecond)
					}
					active.Store(false)
					if lastActiveNodeKeepAliveTimeTag.Equal(inst.ActiveNodeKeepAliveTimeTag) {
						countKeepAliveUpdates++
					}
					lastActiveNodeKeepAliveTimeTag = inst.ActiveNodeKeepAliveTimeTag
					if countKeepAliveUpdates > countKeepAliveUpdatesLimit { // time exceeded, be active
						jscfg.Log(jscfg.LogLevelBasic, "Redundancy - ACTIVATING this Node!")
						active.Store(true)
					}
				}

				if active.Load() {
					jscfg.Log(jscfg.LogLevelBasic, "Redundancy - This node is active.")
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					_, err := collInsts.UpdateOne(ctx, bson.M{
						"protocolDriver":               driverName,
						"protocolDriverInstanceNumber": instanceNumber,
					}, bson.M{"$set": bson.M{
						"activeNodeName":             cfg.NodeName,
						"activeNodeKeepAliveTimeTag": time.Now(),
					}})
					cancel()
					if err != nil {
						jscfg.Log(jscfg.LogLevelBasic, "Redundancy - Error updating keep alive: "+err.Error())
					}
					if statsFn != nil {
						statsFn(collConns)
					}
				} else {
					if inst.ActiveNodeName != "" {
						jscfg.Log(jscfg.LogLevelBasic, "Redundancy - This node is INACTIVE! Node '"+inst.ActiveNodeName+"' is active, wait...")
					} else {
						jscfg.Log(jscfg.LogLevelBasic, "Redundancy - This node is INACTIVE! No node is active, wait...")
					}
				}

				time.Sleep(5 * time.Second)
			}
		}()
	}
}
