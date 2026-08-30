/*
 * DNP3 Client and Server Protocol drivers for {json:scada}, in Go.
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

// Active/standby arbitration and the keep-alive heartbeat. Port of
// processRedundancy() of the C++ client.

package redundancy

import (
	"context"
	"sync/atomic"
	"time"

	"dnp3-go/internal/jscfg"
	"dnp3-go/internal/mongoutil"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const (
	// StaleTimeout is how long a node's keep-alive may go unwritten before
	// another node takes over.
	StaleTimeout = 15 * time.Second
	// TickPeriod is how often the arbitration runs.
	TickPeriod = 5 * time.Second
	// RetryPeriod is the pause after a MongoDB failure.
	RetryPeriod = 3 * time.Second
)

// Controller arbitrates which node runs the protocol.
type Controller struct {
	Config         jscfg.Config
	DriverName     string
	InstanceNumber int

	// OnActivate is called when this node takes over, OnDeactivate when it
	// gives up. Neither is called for the state the driver is already in.
	OnActivate   func()
	OnDeactivate func()
	// OnTick is called on every cycle while active, after the keep-alive is
	// written, with a live database handle. Both drivers use it to write the
	// connection statistics.
	OnTick func(db *mongo.Database)

	active atomic.Bool
}

// Active reports whether this node currently runs the protocol.
func (c *Controller) Active() bool { return c.active.Load() }

// Run arbitrates until the context is cancelled.
func (c *Controller) Run(ctx context.Context) {
	for ctx.Err() == nil {
		cli, err := mongoutil.Connect(c.Config)
		if err != nil {
			jscfg.Log(jscfg.LogLevelNoLog, "Exception Mongo Redundancy: %v", err)
			sleep(ctx, RetryPeriod)
			continue
		}
		c.loop(ctx, cli.Database(c.Config.MongoDatabaseName))
		_ = cli.Disconnect(context.Background())
		sleep(ctx, RetryPeriod)
	}
}

// loop runs the arbitration on one database handle until it fails.
func (c *Controller) loop(ctx context.Context, db *mongo.Database) {
	instances := db.Collection(jscfg.ProtocolDriverInstancesCollectionName)

	for ctx.Err() == nil {
		if !mongoutil.IsLive(db) {
			jscfg.Log(jscfg.LogLevelNoLog, "Exception Mongo Redundancy: MongoDB connection failed")
			return
		}

		shouldBeActive := c.shouldBeActive(ctx, instances)
		was := c.active.Swap(shouldBeActive)

		switch {
		case shouldBeActive && !was:
			jscfg.Log(jscfg.LogLevelNoLog, "Redundancy - ACTIVATING this node!")
			if c.OnActivate != nil {
				c.OnActivate()
			}
		case !shouldBeActive && was:
			jscfg.Log(jscfg.LogLevelNoLog, "Redundancy - DEACTIVATING this node.")
			if c.OnDeactivate != nil {
				c.OnDeactivate()
			}
		case !shouldBeActive:
			jscfg.Log(jscfg.LogLevelDetailed, "Redundancy - Node is STANDBY; protocol sessions remain stopped.")
		}

		if shouldBeActive {
			c.writeKeepAlive(ctx, instances)
			if c.OnTick != nil {
				c.OnTick(db)
			}
		}

		if !sleep(ctx, TickPeriod) {
			return
		}
	}
}

// shouldBeActive decides whether this node runs the protocol: it does when it
// is the named active node, or when the named one has stopped writing its
// keep-alive.
func (c *Controller) shouldBeActive(ctx context.Context, instances *mongo.Collection) bool {
	tctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.M
	err := instances.FindOne(tctx, bson.M{
		"protocolDriver":               c.DriverName,
		"protocolDriverInstanceNumber": c.InstanceNumber,
	}).Decode(&doc)
	if err != nil {
		// No instance document: the C++ driver defaults to active, so that a
		// single-node system with an incomplete configuration still runs.
		return true
	}

	activeNode := mongoutil.GetString(doc, "activeNodeName", "")
	if activeNode == c.Config.NodeName {
		return true
	}
	if activeNode == "" {
		return true
	}
	keepAlive := mongoutil.GetDateMs(doc, "activeNodeKeepAliveTimeTag", 0)
	if keepAlive == 0 {
		return true
	}
	return time.Since(time.UnixMilli(keepAlive)) > StaleTimeout
}

// writeKeepAlive claims the instance for this node.
func (c *Controller) writeKeepAlive(ctx context.Context, instances *mongo.Collection) {
	tctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	_, err := instances.UpdateOne(tctx,
		bson.M{
			"protocolDriver":               c.DriverName,
			"protocolDriverInstanceNumber": c.InstanceNumber,
		},
		bson.M{"$set": bson.M{
			"activeNodeName":             c.Config.NodeName,
			"activeNodeKeepAliveTimeTag": mongoutil.Now(),
		}})
	if err != nil {
		jscfg.Log(jscfg.LogLevelDetailed, "Redundancy - Failed to write the keep-alive: %v", err)
	}
}

// sleep waits, reporting false when the context ended first.
func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
