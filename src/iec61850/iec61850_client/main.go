/*
 * IEC 61850 MMS Client driver for {json:scada}, in Go.
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * A drop-in alternative to the C# driver of src/iec61850_client: same
 * protocol driver name, same configuration documents, same MongoDB
 * semantics, with no native library dependency.
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

package main

import (
	"context"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// instanceNumber is the driver instance this process runs.
var instanceNumber = 1

func main() {
	cfg, instNum := readConfigFile()
	instanceNumber = instNum

	cli, err := mongoConnect(cfg)
	if err != nil {
		Fatal("Error connecting to MongoDB - %v", err)
	}
	db := cli.Database(cfg.MongoDatabaseName)

	inst := loadInstance(db, cfg)
	Log(LogLevelNoLog, "Instance: %d", inst.ProtocolDriverInstanceNumber)

	conns := loadConnections(db)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go redundancyLoop(ctx, cfg, conns)
	go mongoUpdateLoop(ctx, cfg, conns)
	go commandsLoop(ctx, cfg, conns)

	for _, conn := range conns {
		Log(LogLevelNoLog, "%s - New Connection", conn.Name)
		go connectionLoop(ctx, conn)
	}

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)

	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-sigs:
			Log(LogLevelNoLog, "Exiting application!")
			cancel()
			for _, conn := range conns {
				closeConnection(conn)
			}
			LogFlush()
			os.Exit(0)
		case <-ticker.C:
		}
	}
}

// loadInstance reads the driver instance document and validates it can run
// on this node, with the same checks and messages as the C# driver.
func loadInstance(db *mongo.Database, cfg JSONSCADAConfig) *ProtocolDriverInstance {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	coll := db.Collection(ProtocolDriverInstancesCollectionName)
	cur, err := coll.Find(ctx, bson.M{
		"protocolDriver":               ProtocolDriverName,
		"protocolDriverInstanceNumber": instanceNumber,
	})
	if err != nil {
		Fatal("Error reading driver instances - %v", err)
	}
	var docs []bson.M
	if err := cur.All(ctx, &docs); err != nil {
		Fatal("Error reading driver instances - %v", err)
	}
	if len(docs) == 0 {
		Fatal("Driver instance [%d] not found in configuration!", instanceNumber)
	}

	// parity: the C# driver only ever looks at the first document.
	inst := instanceFromDoc(docs[0])
	if !inst.Enabled {
		Fatal("Driver instance [%d] disabled!", instanceNumber)
	}
	if !nodeAllowed(inst, cfg.NodeName) {
		Fatal("Node '%s' not found in instances configuration!", cfg.NodeName)
	}
	return inst
}

// loadConnections reads the enabled connections of this instance and
// preloads the tags configured for each of them.
func loadConnections(db *mongo.Database) []*Iec61850Connection {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	coll := db.Collection(ProtocolConnectionsCollectionName)
	cur, err := coll.Find(ctx, bson.M{
		"protocolDriver":               ProtocolDriverName,
		"protocolDriverInstanceNumber": instanceNumber,
		"enabled":                      true,
	})
	if err != nil {
		Fatal("Error reading protocol connections - %v", err)
	}
	var docs []bson.M
	if err := cur.All(ctx, &docs); err != nil {
		Fatal("Error reading protocol connections - %v", err)
	}

	collRTD := db.Collection(RealtimeDataCollectionName)
	conns := make([]*Iec61850Connection, 0, len(docs))

	for _, doc := range docs {
		conn := connectionFromDoc(doc)
		preloadEntries(ctx, collRTD, conn)
		conn.LastNewKeyCreated = 0
		if len(conn.IPAddresses) < 1 {
			Fatal("Missing remote endpoint URLs list!")
		}
		conns = append(conns, conn)
	}

	if len(conns) == 0 {
		Fatal("No connections found!")
	}
	return conns
}

// preloadEntries loads the tags of a connection: both supervised points and
// command points, since commands are dispatched through the same map.
func preloadEntries(ctx context.Context, collRTD *mongo.Collection, conn *Iec61850Connection) {
	cur, err := collRTD.Find(ctx, bson.M{
		"protocolSourceConnectionNumber": conn.ProtocolConnectionNumber,
	})
	if err != nil {
		Fatal("Error reading realtime data - %v", err)
	}
	var docs []bson.M
	if err := cur.All(ctx, &docs); err != nil {
		Fatal("Error reading realtime data - %v", err)
	}

	for _, doc := range docs {
		tag := mString(doc, "tag", "")
		objAddr := strings.TrimSpace(mString(doc, "protocolSourceObjectAddress", ""))
		commonAddr := strings.ToUpper(strings.TrimSpace(mString(doc, "protocolSourceCommonAddress", "")))
		if conn.AutoCreateTags {
			conn.InsertedTags[tag] = true
		}
		if objAddr == "" {
			continue
		}
		entry := &Iec61850Entry{
			Path:  objAddr,
			FC:    parseFCOrST(commonAddr),
			JsTag: tag,
		}
		key := objAddr + commonAddr
		if _, dup := conn.Entries[key]; !dup {
			conn.Entries[key] = entry
			conn.EntryOrder = append(conn.EntryOrder, key)
		}
	}
	Log(LogLevelDetailed, "%s - %d tags configured", conn.Name, len(conn.Entries))
}
