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

// Shared MongoDB handles. The writers keep running while the connection is
// being re-established; they simply hold their batch until the handles are
// published again.

package main

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"go.mongodb.org/mongo-driver/v2/mongo/writeconcern"
)

// MongoState publishes the current connection and collection handles.
type MongoState struct {
	mu        sync.RWMutex
	client    *mongo.Client
	db        *mongo.Database
	rt        *mongo.Collection // realtimeData, default write concern
	rtFast    *mongo.Collection // realtimeData, unacknowledged writes
	hist      *mongo.Collection // hist, unacknowledged writes
	soe       *mongo.Collection // soeData, unacknowledged writes
	connected atomic.Bool
	// generation increases on every successful (re)connection, so waiters
	// can tell a stale handle from a fresh one.
	generation atomic.Int64
	ready      chan struct{}
}

// Mongo is the process wide connection state.
var Mongo = &MongoState{ready: make(chan struct{}, 1)}

func mongoIsConnected() bool { return Mongo.connected.Load() }

// Set publishes a new set of handles.
func (m *MongoState) Set(client *mongo.Client, db *mongo.Database) {
	unack := options.Collection().SetWriteConcern(writeconcern.Unacknowledged())
	m.mu.Lock()
	m.client = client
	m.db = db
	if db != nil {
		m.rt = db.Collection(RealtimeDataCollectionName)
		m.rtFast = db.Collection(RealtimeDataCollectionName, unack)
		m.hist = db.Collection(HistCollectionName, unack)
		m.soe = db.Collection(SoeDataCollectionName, unack)
	} else {
		m.rt, m.rtFast, m.hist, m.soe = nil, nil, nil, nil
	}
	m.mu.Unlock()
	m.connected.Store(db != nil)
	if db != nil {
		m.generation.Add(1)
		select {
		case m.ready <- struct{}{}:
		default:
		}
	}
}

// Clear drops the handles after a connection loss.
func (m *MongoState) Clear() {
	m.Set(nil, nil)
}

// Handles returns the current collections; ok is false while disconnected.
func (m *MongoState) Handles() (rt, rtFast, hist, soe *mongo.Collection, db *mongo.Database, ok bool) {
	m.mu.RLock()
	rt, rtFast, hist, soe, db = m.rt, m.rtFast, m.hist, m.soe, m.db
	m.mu.RUnlock()
	ok = m.connected.Load() && rt != nil
	return
}

// Client returns the current client.
func (m *MongoState) Client() *mongo.Client {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.client
}

// WaitReady blocks until the connection is usable or ctx is done.
func (m *MongoState) WaitReady(ctx context.Context) bool {
	for {
		if m.connected.Load() {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-m.ready:
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// pingMongo is the equivalent of checkConnectedMongo() in the Node.js code.
func pingMongo(client *mongo.Client, timeout time.Duration) bool {
	if client == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var res bson.M
	err := client.Database("admin").RunCommand(ctx, bson.D{{Key: "ping", Value: 1}}).Decode(&res)
	if err != nil {
		Log(LogLevelMin, "Error on mongodb connection! %v", err)
		return false
	}
	if ok, exists := res["ok"]; exists {
		switch v := ok.(type) {
		case float64:
			return v != 0
		case int32:
			return v != 0
		case int64:
			return v != 0
		}
	}
	return false
}
