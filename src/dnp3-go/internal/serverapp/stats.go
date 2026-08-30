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

// The stats sub-document of protocolConnections. The C++ server writes none;
// this is the same shape the client driver writes (deviation D20).

package serverapp

import (
	"context"
	"time"

	"dnp3-go/internal/jscfg"
	"dnp3-go/internal/mongoutil"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// writeStats refreshes the statistics of every connection.
func (e *Engine) writeStats(ctx context.Context, db *mongo.Database) {
	coll := db.Collection(jscfg.ProtocolConnectionsCollectionName)
	now := mongoutil.Now()

	for _, conn := range e.conns {
		if conn.Group == nil {
			continue
		}
		counters := conn.Group.Counters.Snapshot()
		busStats := conn.Group.Stats()

		// An outstation has no Connected() of its own — it answers whoever
		// polls it — so the state comes from the channel its session runs on.
		// Deriving it from traffic instead would report a station down
		// whenever the master's poll interval exceeded the window, and the
		// JSON-SCADA default integrity interval is 300 seconds.
		connected := conn.link.Up()

		var (
			confirmTimeouts uint64
			eventsQueued    int
		)
		if s := conn.Station(); s != nil {
			confirmTimeouts = s.Stats().ConfirmTimeouts
			eventsQueued = s.Events().Total()
		}

		stats := bson.M{
			"nodeName":          e.cfg.NodeName,
			"timeTag":           now,
			"isConnected":       connected,
			"numBytesRx":        int64(counters.BytesRx),
			"numBytesTx":        int64(counters.BytesTx),
			"numOpen":           int64(counters.Opens),
			"numClose":          int64(counters.Closes),
			"numOpenFail":       int64(counters.OpenFails),
			"numLinkFrameRx":    int64(busStats.FramesDecoded),
			"numLinkFrameTx":    int64(busStats.FramesRouted),
			"numHeaderCrcError": int64(busStats.HeaderCRCErrors),
			"numBodyCrcError":   int64(busStats.BodyCRCErrors),
			"confirmTimeouts":   int64(confirmTimeouts),
			"eventsQueued":      int64(eventsQueued),
		}

		tctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err := coll.UpdateOne(tctx,
			bson.M{"protocolConnectionNumber": conn.ProtocolConnectionNumber},
			bson.M{"$set": bson.M{"stats": stats}})
		cancel()
		if err != nil {
			jscfg.Log(jscfg.LogLevelDetailed, "%s - Failed to write statistics: %v", conn.Name, err)
		}
	}
}
