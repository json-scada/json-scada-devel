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

// MongoDB connection helpers.

package mongoutil

import (
	"context"
	"time"

	"dnp3-go/internal/jscfg"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Connect opens a client. Every long-running goroutine of both drivers owns
// its own, the way the C++ drivers open a mongocxx::client per thread: a
// change-stream cursor blocks its client, so sharing one would stall the
// others.
// No client-level Timeout is set: it applies to every operation, and a change
// stream's Next is one, so a watcher would be torn down and rebuilt on each
// expiry. Every call that needs a bound passes its own context deadline.
func Connect(cfg jscfg.Config) (*mongo.Client, error) {
	return mongo.Connect(options.Client().ApplyURI(cfg.MongoConnectionString))
}

// IsLive pings the database. Port of isConnected()/isMongoLive().
func IsLive(db *mongo.Database) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return db.RunCommand(ctx, bson.D{{Key: "ping", Value: 1}}).Err() == nil
}

// ConnectAndWait retries until the database answers a ping, logging each
// attempt the way the C++ server does.
func ConnectAndWait(ctx context.Context, cfg jscfg.Config) (*mongo.Client, *mongo.Database, error) {
	for {
		jscfg.Log(jscfg.LogLevelBasic, "Connecting to MongoDB")
		cli, err := Connect(cfg)
		if err == nil {
			db := cli.Database(cfg.MongoDatabaseName)
			if IsLive(db) {
				jscfg.Log(jscfg.LogLevelBasic, "Connected to MongoDB")
				return cli, db, nil
			}
			_ = cli.Disconnect(context.Background())
		}
		select {
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case <-time.After(5 * time.Second):
		}
	}
}

// FindAll runs a query and decodes every document into a bson.M slice.
func FindAll(ctx context.Context, coll *mongo.Collection, filter any, opts ...options.Lister[options.FindOptions]) ([]bson.M, error) {
	cur, err := coll.Find(ctx, filter, opts...)
	if err != nil {
		return nil, err
	}
	var docs []bson.M
	if err := cur.All(ctx, &docs); err != nil {
		return nil, err
	}
	return docs, nil
}

// Now is the timestamp written into every document the drivers create.
func Now() bson.DateTime {
	return bson.NewDateTimeFromTime(time.Now())
}
