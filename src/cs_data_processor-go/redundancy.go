/*
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

// Redundancy control, port of redundancy.js. Exactly one node of an instance
// processes changes; the standby takes over when the active node stops
// refreshing its keep-alive. The latency statistics are published in the same
// stats field the Node.js version writes (empty there), which makes them
// visible from the AdminUI without any extra plumbing.

package main

import (
	"context"
	"os"
	"sync/atomic"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

const countKeepAliveUpdatesLimit = 4

var processActive atomic.Bool

// ProcessStateIsActive reports whether this node is the active one.
func ProcessStateIsActive() bool { return processActive.Load() }

type redundancyState struct {
	lastActiveNodeKeepAliveTimeTag string
	countKeepAliveNotUpdated       int
}

// StartRedundancy runs the redundancy cycle every interval.
func StartRedundancy(ctx context.Context, cfg Config, interval time.Duration, p *Processor) {
	go func() {
		st := &redundancyState{}
		processRedundancy(ctx, cfg, st, p)
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if !mongoIsConnected() {
					processActive.Store(false)
					continue
				}
				processRedundancy(ctx, cfg, st, p)
			}
		}
	}()
}

func processRedundancy(ctx context.Context, cfg Config, st *redundancyState, p *Processor) {
	_, _, _, _, db, ok := Mongo.Handles()
	if !ok || db == nil {
		return
	}
	coll := db.Collection(ProcessInstancesCollectionName)

	Log(LogLevelNormal, "Redundancy - Process %s", activeWord(ProcessStateIsActive()))

	filter := bson.D{
		{Key: "processName", Value: AppName},
		{Key: "processInstanceNumber", Value: float64(cfg.Instance)},
	}

	opCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	var doc bson.Raw
	err := coll.FindOne(opCtx, filter).Decode(&doc)
	if err == mongo.ErrNoDocuments {
		// not found, then create
		processActive.Store(true)
		Log(LogLevelMin, "Redundancy - Instance config not found, creating one...")
		_, err = coll.InsertOne(opCtx, bson.D{
			{Key: "processName", Value: AppName},
			{Key: "processInstanceNumber", Value: float64(cfg.Instance)},
			{Key: "enabled", Value: true},
			{Key: "logLevel", Value: float64(cfg.LogLevel)},
			{Key: "nodeNames", Value: bson.A{}},
			{Key: "activeNodeName", Value: cfg.NodeName},
			{Key: "activeNodeKeepAliveTimeTag", Value: time.Now()},
		})
		if err != nil {
			Log(LogLevelMin, "Redundancy - Error: %v", err)
		}
		return
	}
	if err != nil {
		Log(LogLevelMin, "Redundancy - Error: %v", err)
		return
	}

	inst := rawDoc{raw: doc}

	instKeepAlive := ""
	if t, ok := inst.timeOf("activeNodeKeepAliveTimeTag"); ok {
		instKeepAlive = jsISODate(t)
	}

	if en, ok := inst.boolStrict("enabled"); ok && !en {
		Log(LogLevelMin, "Redundancy - Instance disabled, exiting...")
		time.Sleep(500 * time.Millisecond)
		os.Exit(0)
	}
	if names := inst.lookup("nodeNames"); names.Type == bson.TypeArray {
		if vals, err := names.Array().Values(); err == nil && len(vals) > 0 {
			found := false
			for _, v := range vals {
				if s, ok := v.StringValueOK(); ok && s == cfg.NodeName {
					found = true
					break
				}
			}
			if !found {
				Log(LogLevelMin, "Redundancy - Node name not allowed, exiting...")
				time.Sleep(500 * time.Millisecond)
				os.Exit(0)
			}
		}
	}

	if inst.str("activeNodeName") == cfg.NodeName {
		if !ProcessStateIsActive() {
			Log(LogLevelMin, "Redundancy - Node activated!")
		}
		st.countKeepAliveNotUpdated = 0
		processActive.Store(true)
	} else {
		// other node active
		if ProcessStateIsActive() {
			Log(LogLevelMin, "Redundancy - Node deactivated!")
			st.countKeepAliveNotUpdated = 0
		}
		processActive.Store(false)
		if st.lastActiveNodeKeepAliveTimeTag == instKeepAlive {
			st.countKeepAliveNotUpdated++
			Log(LogLevelNormal, "Redundancy - Keep-alive from active node not updated. %d",
				st.countKeepAliveNotUpdated)
		} else {
			st.countKeepAliveNotUpdated = 0
			Log(LogLevelNormal, "Redundancy - Keep-alive updated by active node. Staying inactive.")
		}
		st.lastActiveNodeKeepAliveTimeTag = instKeepAlive
		if st.countKeepAliveNotUpdated > countKeepAliveUpdatesLimit {
			st.countKeepAliveNotUpdated = 0
			Log(LogLevelMin, "Redundancy - Node activated!")
			processActive.Store(true)
		}
	}

	if ProcessStateIsActive() {
		// active, then update the keep-alive and publish the latency stats
		_, err := coll.UpdateOne(opCtx, filter, bson.D{{Key: "$set", Value: bson.D{
			{Key: "activeNodeName", Value: cfg.NodeName},
			{Key: "activeNodeKeepAliveTimeTag", Value: time.Now()},
			{Key: "softwareVersion", Value: AppVersion},
			{Key: "stats", Value: statsDocument()},
		}}})
		if err != nil {
			Log(LogLevelMin, "Redundancy - Error: %v", err)
		}
	}
}

func activeWord(a bool) string {
	if a {
		return "Active"
	}
	return "Inactive"
}

// statsDocument condenses the metrics snapshot into the processInstances
// stats field, using the same names as the /metrics endpoint.
func statsDocument() bson.D {
	s := M.Snapshot()
	lat := bson.D{}
	for _, name := range stageOrder {
		st, ok := s.Latency[name]
		if !ok || st.Count == 0 {
			continue
		}
		lat = append(lat, bson.E{Key: name, Value: bson.D{
			{Key: "count", Value: st.Count},
			{Key: "avgMs", Value: st.AvgMs},
			{Key: "p50Ms", Value: st.P50Ms},
			{Key: "p90Ms", Value: st.P90Ms},
			{Key: "p99Ms", Value: st.P99Ms},
			{Key: "maxMs", Value: st.MaxMs},
		}})
	}
	cnt := bson.D{}
	for _, name := range counterOrder {
		if v, ok := s.Counters[name]; ok && v != 0 {
			cnt = append(cnt, bson.E{Key: name, Value: v})
		}
	}
	return bson.D{
		{Key: "implementation", Value: s.Implementation},
		{Key: "uptimeSec", Value: s.UptimeSec},
		{Key: "windowSec", Value: s.WindowSec},
		{Key: "changesPerSec", Value: s.RatesPerSec[CntChangesProcessed]},
		{Key: "counters", Value: cnt},
		{Key: "latencyMs", Value: lat},
	}
}
