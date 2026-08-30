/*
 * DNP3 Outstation Server Protocol driver for {json:scada}, in Go.
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

// Assigning DNP3 object addresses to tags not yet distributed on a connection.
// Port of AutoCreateDestinations() of the corrected C++ server v0.1.1.

package serverapp

import (
	"context"
	"strconv"

	"dnp3-go/internal/dnp3util"
	"dnp3-go/internal/jscfg"
	"dnp3-go/internal/mongoutil"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MaxObjectAddress is the highest DNP3 object address.
const MaxObjectAddress = 65535

// autoCreatePass is one group's worth of automatic distribution.
type autoCreatePass struct {
	tagType         string
	origin          string
	group           int
	asdu            float64
	commandDuration float64
	whatOverflows   string
}

// autoCreateAll runs the four passes of the C++ server, in its order: commands
// first when they are enabled, then supervised points.
func (e *Engine) autoCreateAll(ctx context.Context, db *mongo.Database, conn *Connection) error {
	if !conn.AutoCreateTags {
		return nil
	}
	jscfg.Log(jscfg.LogLevelBasic, "Auto Create Tags is enabled")

	passes := []autoCreatePass{}
	if conn.CommandsEnabled {
		// Digital commands are distributed as group 12 variation 1, analog
		// commands as group 41 variation 3.
		passes = append(passes,
			autoCreatePass{"digital", "command", dnp3util.GroupCROBCommand, 1.0, 11.0, "crob commands"},
			autoCreatePass{"analog", "command", dnp3util.GroupAnalogOutputBlock, 3.0, 0.0, "analog outputs"},
		)
	}
	passes = append(passes,
		// Digital points as group 1 variation 2, analog points as group 30
		// variation 6 (double precision).
		autoCreatePass{"digital", "supervised", dnp3util.GroupBinaryInput, 2.0, 0.0, "digitals"},
		autoCreatePass{"analog", "supervised", dnp3util.GroupAnalogInput, 6.0, 0.0, "analogs"},
	)

	for _, p := range passes {
		if err := e.autoCreatePass(ctx, db, conn, p); err != nil {
			return err
		}
	}
	return nil
}

// autoCreatePass assigns addresses for one group.
//
// Addresses continue from the highest already assigned on this connection *for
// this group*: every group has its own address space, so a tag distributed at
// group 30 must not push the next group 12 address along.
func (e *Engine) autoCreatePass(ctx context.Context, db *mongo.Database, conn *Connection, p autoCreatePass) error {
	rtd := db.Collection(jscfg.RealtimeDataCollectionName)

	// The conditions are combined with $elemMatch so they hold for one entry of
	// the array, and the entry is checked again when walking it: as separate
	// dotted paths, a destination of another group or another connection would
	// contribute its address to this group's maximum.
	assigned, err := mongoutil.FindAll(ctx, rtd, bson.M{
		"type":   p.tagType,
		"origin": p.origin,
		"protocolDestinations": bson.M{"$elemMatch": bson.M{
			"protocolDestinationConnectionNumber": conn.ProtocolConnectionNumber,
			"protocolDestinationCommonAddress":    p.group,
		}},
	})
	if err != nil {
		return err
	}

	lastAddr := -1
	for _, doc := range assigned {
		for _, d := range DestinationsOf(doc) {
			if d.ConnectionNumber != conn.ProtocolConnectionNumber || d.CommonAddress != p.group {
				continue
			}
			if d.ObjectAddress > lastAddr {
				lastAddr = d.ObjectAddress
			}
		}
	}
	jscfg.Log(jscfg.LogLevelBasic, "%s - Last Group %d Address: %d", conn.Name, p.group, lastAddr)

	// Tags of this kind with no destination on this connection yet. $ne on an
	// array field matches a document when no element of it equals the value,
	// which is also true of a document with no destinations at all.
	candidates, err := mongoutil.FindAll(ctx, rtd, bson.M{
		"type":   p.tagType,
		"origin": p.origin,
		"protocolDestinations.protocolDestinationConnectionNumber": bson.M{
			"$ne": conn.ProtocolConnectionNumber,
		},
	}, options.Find().SetSort(bson.M{"_id": 1}))
	if err != nil {
		return err
	}

	for _, doc := range candidates {
		if !conn.MatchesTopic(mongoutil.GetString(doc, "group1", "")) {
			continue
		}
		lastAddr++
		if lastAddr > MaxObjectAddress {
			jscfg.Log(jscfg.LogLevelBasic, "%s - Object address for %s exceeds 65535!",
				conn.Name, p.whatOverflows)
			break
		}

		id := mongoutil.GetDouble(doc, "_id", 0)
		jscfg.Log(jscfg.LogLevelBasic, "%s - Creating destination for tag: %s %s Dnp3Address: %s",
			conn.Name, mongoutil.FormatID(id), mongoutil.GetString(doc, "tag", ""),
			strconv.Itoa(lastAddr))

		if v, ok := doc["protocolDestinations"]; !ok || v == nil {
			if _, err := rtd.UpdateOne(ctx, bson.M{"_id": id},
				bson.M{"$set": bson.M{"protocolDestinations": bson.A{}}}); err != nil {
				return err
			}
		}
		if _, err := rtd.UpdateOne(ctx, bson.M{"_id": id},
			bson.M{"$push": bson.M{"protocolDestinations": bson.M{
				"protocolDestinationConnectionNumber": float64(conn.ProtocolConnectionNumber),
				"protocolDestinationCommonAddress":    float64(p.group),
				"protocolDestinationObjectAddress":    float64(lastAddr),
				"protocolDestinationASDU":             p.asdu,
				"protocolDestinationCommandDuration":  p.commandDuration,
				"protocolDestinationCommandUseSBO":    false,
				"protocolDestinationKConv1":           1.0,
				"protocolDestinationKConv2":           0.0,
				"protocolDestinationGroup":            0.0,
				"protocolDestinationHoursShift":       0.0,
			}}}); err != nil {
			return err
		}
	}
	return nil
}
