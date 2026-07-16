/*
 * IEC 60870-5-101/104 protocol drivers for {json:scada} - MongoDB helpers
 * {json:scada} - Copyright (c) 2020 - 2026 - Ricardo L. Olsen
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

package mongoutil

import (
	"context"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"iec60870-5/internal/jscfg"
)

// Collection names (same as C# drivers).
const (
	RealtimeDataCollectionName            = "realtimeData"
	ProtocolDriverInstancesCollectionName = "protocolDriverInstances"
	ProtocolConnectionsCollectionName     = "protocolConnections"
	CommandsQueueCollectionName           = "commandsQueue"
)

// Connect connects to the MongoDB server configured in cfg, appending TLS
// URI options when PEM files are configured (same approach as plc4x-client).
func Connect(cfg jscfg.Config) (*mongo.Client, *mongo.Database, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	cs := cfg.MongoConnectionString
	appendOpt := func(opt string) {
		if strings.Contains(cs, "?") {
			cs += "&" + opt
		} else {
			cs += "/?" + opt
		}
	}
	if cfg.TLSCaPemFile != "" || cfg.TLSClientPemFile != "" {
		appendOpt("tls=true")
	}
	if cfg.TLSCaPemFile != "" {
		appendOpt("tlsCAFile=" + cfg.TLSCaPemFile)
	}
	if cfg.TLSClientPemFile != "" {
		appendOpt("tlsCertificateKeyFile=" + cfg.TLSClientPemFile)
	}
	if cfg.TLSClientKeyPassword != "" {
		appendOpt("tlsCertificateKeyFilePassword=" + cfg.TLSClientKeyPassword)
	}
	if cfg.TLSInsecure || cfg.TLSAllowChainErrors {
		appendOpt("tlsInsecure=true")
	}
	if cfg.TLSAllowInvalidHostnames {
		appendOpt("tlsAllowInvalidHostnames=true")
	}

	client, err := mongo.Connect(options.Client().ApplyURI(cs))
	if err != nil {
		return nil, nil, err
	}
	if err = client.Ping(ctx, nil); err != nil {
		return nil, nil, err
	}
	return client, client.Database(cfg.MongoDatabaseName), nil
}

// PingOK checks database liveness with a short timeout.
func PingOK(client *mongo.Client) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return client.Ping(ctx, nil) == nil
}

// ToFloat64 converts a decoded BSON value permissively to float64,
// mirroring the C# BsonDoubleSerializer (accepts numerics, bool, string).
func ToFloat64(v interface{}) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case float32:
		return float64(t)
	case int:
		return float64(t)
	case int32:
		return float64(t)
	case int64:
		return float64(t)
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		f, err := strconv.ParseFloat(t, 64)
		if err == nil {
			return f
		}
	case bson.Decimal128:
		f, err := strconv.ParseFloat(t.String(), 64)
		if err == nil {
			return f
		}
	}
	return 0
}

// ToBool converts a decoded BSON value permissively to bool.
func ToBool(v interface{}) bool {
	switch t := v.(type) {
	case bool:
		return t
	default:
		return ToFloat64(t) != 0
	}
}

// ToString converts a decoded BSON value to string.
func ToString(v interface{}) string {
	switch t := v.(type) {
	case string:
		return t
	case nil:
		return ""
	default:
		return ""
	}
}

// ToTime converts a decoded BSON value to time.Time (zero when absent).
func ToTime(v interface{}) time.Time {
	switch t := v.(type) {
	case bson.DateTime:
		return t.Time()
	case time.Time:
		return t
	}
	return time.Time{}
}
