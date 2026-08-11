/*
 * IEC 61850 MMS Server driver (IEC61850-90-2 gateway) for {json:scada}, in Go.
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

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Driver identity, matching the C# driver so the same instance and
// connection documents drive either binary.
const (
	CopyrightMessage   = "{json:scada} IEC61850 Server Driver (IEC61850-90-2, Go) - Copyright 2020-2026 Ricardo Olsen"
	ProtocolDriverName = "IEC61850_SERVER"
	DriverVersion      = "0.1.2"
	LibraryVersion     = "v0.2.3"
)

// Collection names.
const (
	ProtocolConnectionsCollectionName     = "protocolConnections"
	ProtocolDriverInstancesCollectionName = "protocolDriverInstances"
	RealtimeDataCollectionName            = "realtimeData"
	CommandsQueueCollectionName           = "commandsQueue"
)

// Default config file locations, in the C# driver's resolution order.
const (
	JSONConfigFilePath    = "../conf/json-scada.json"
	JSONConfigFilePathAlt = "c:/json-scada/conf/json-scada.json"
)

// JSONSCADAConfig is conf/json-scada.json.
type JSONSCADAConfig struct {
	NodeName                 string `json:"nodeName"`
	MongoConnectionString    string `json:"mongoConnectionString"`
	MongoDatabaseName        string `json:"mongoDatabaseName"`
	TLSCaPemFile             string `json:"tlsCaPemFile"`
	TLSClientPemFile         string `json:"tlsClientPemFile"`
	TLSClientPfxFile         string `json:"tlsClientPfxFile"`
	TLSClientKeyPassword     string `json:"tlsClientKeyPassword"`
	TLSAllowInvalidHostnames bool   `json:"tlsAllowInvalidHostnames"`
	TLSAllowChainErrors      bool   `json:"tlsAllowChainErrors"`
	TLSInsecure              bool   `json:"tlsInsecure"`
}

// ProtocolDriverInstance is a document of protocolDriverInstances.
type ProtocolDriverInstance struct {
	ID                               bson.ObjectID
	ProtocolDriver                   string
	ProtocolDriverInstanceNumber     int
	Enabled                          bool
	LogLevel                         int
	NodeNames                        []string
	ActiveNodeName                   string
	ActiveNodeKeepAliveTimeTag       time.Time
	KeepProtocolRunningWhileInactive bool
}

// ServerConnection is the single protocolConnections document this driver
// instance serves.
type ServerConnection struct {
	ID                            bson.ObjectID
	ProtocolDriver                string
	ProtocolDriverInstanceNumber  int
	ProtocolConnectionNumber      int
	Name                          string
	Description                   string
	Enabled                       bool
	CommandsEnabled               bool
	IPAddressLocalBind            string
	IPAddresses                   []string
	Topics                        []string
	ServerModeMultiActive         bool
	MaxClientConnections          float64
	MaxQueueSize                  float64
	UseSecurity                   bool
	LocalCertFilePath             string
	PrivateKeyFilePath            string
	PeerCertFilesPaths            []string
	RootCertFilePath              string
	ChainValidation               bool
	AllowOnlySpecificCertificates bool
	AllowTLSv10                   bool
	AllowTLSv11                   bool
	AllowTLSv12                   bool
	AllowTLSv13                   bool
	CipherList                    string
	Username                      string
	Password                      string
}

// readConfigFile parses the command line and conf/json-scada.json with the
// same semantics as the C# driver: arg1 instance number, arg2 log level,
// arg3 config file path (used only when the file exists).
func readConfigFile() (cfg JSONSCADAConfig, instanceNumber int) {
	instanceNumber = 1
	if len(os.Args) > 1 {
		if n, err := strconv.Atoi(strings.TrimSpace(os.Args[1])); err == nil {
			instanceNumber = n
		}
	}
	if len(os.Args) > 2 {
		if n, err := strconv.Atoi(strings.TrimSpace(os.Args[2])); err == nil {
			LogLevel = n
		}
	}

	logBanner()

	fname := JSONConfigFilePath
	if env := os.Getenv("JS_CONFIG_FILE"); env != "" {
		if _, err := os.Stat(env); err == nil {
			fname = env
		}
	}
	if len(os.Args) > 3 {
		if _, err := os.Stat(os.Args[3]); err == nil {
			fname = os.Args[3]
		}
	}
	if _, err := os.Stat(fname); err != nil {
		fname = JSONConfigFilePathAlt
	}
	if _, err := os.Stat(fname); err != nil {
		Fatal("Missing config file %s", JSONConfigFilePath)
	}

	Log(LogLevelNoLog, "Reading config file %s", fname)
	data, err := os.ReadFile(filepath.Clean(fname))
	if err != nil {
		Fatal("Missing config file %s", fname)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		Fatal("Error parsing JSON config file %s - %v", fname, err)
	}

	cfg.MongoConnectionString = strings.TrimSpace(cfg.MongoConnectionString)
	cfg.MongoDatabaseName = strings.TrimSpace(cfg.MongoDatabaseName)
	cfg.NodeName = strings.TrimSpace(cfg.NodeName)

	if cfg.MongoConnectionString == "" {
		Fatal("Missing MongoDB connection string in JSON config file %s", fname)
	}
	if cfg.MongoDatabaseName == "" {
		Fatal("Missing MongoDB database name in JSON config file %s", fname)
	}
	if cfg.NodeName == "" {
		Fatal("Missing nodeName parameter in JSON config file %s", fname)
	}
	Log(LogLevelNoLog, "MongoDB database name: %s", cfg.MongoDatabaseName)
	Log(LogLevelNoLog, "Node name: %s", cfg.NodeName)

	return cfg, instanceNumber
}

func logBanner() {
	Log(LogLevelNoLog, "%s", CopyrightMessage)
	Log(LogLevelNoLog, "Driver version %s", DriverVersion)
	Log(LogLevelNoLog, "Using go-iec61850 version %s", LibraryVersion)
	Log(LogLevelNoLog, "Log level: %d", LogLevel)
}

// mongoConnect opens a MongoDB client, applying the TLS options of the
// json-scada config as URI parameters.
func mongoConnect(cfg JSONSCADAConfig) (*mongo.Client, error) {
	uri := cfg.MongoConnectionString
	if cfg.TLSCaPemFile != "" || cfg.TLSClientPemFile != "" {
		uri += "&tls=true"
	}
	if cfg.TLSCaPemFile != "" {
		uri += "&tlsCAFile=" + cfg.TLSCaPemFile
	}
	if cfg.TLSClientPemFile != "" {
		uri += "&tlsCertificateKeyFile=" + cfg.TLSClientPemFile
	}
	if cfg.TLSClientKeyPassword != "" {
		uri += "&tlsCertificateKeyFilePassword=" + cfg.TLSClientKeyPassword
	}
	if cfg.TLSInsecure || cfg.TLSAllowChainErrors {
		uri += "&tlsInsecure=true"
	}
	if cfg.TLSAllowInvalidHostnames {
		uri += "&tlsAllowInvalidHostnames=true"
	}

	cli, err := mongo.Connect(options.Client().ApplyURI(uri))
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := cli.Ping(ctx, nil); err != nil {
		return nil, err
	}
	return cli, nil
}

// mongoPing checks the database is answering, with the budget the C#
// driver allowed for the same test.
func mongoPing(db *mongo.Database, budget time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	return db.RunCommand(ctx, bson.D{{Key: "ping", Value: 1}}).Err()
}

// --- permissive BSON accessors -------------------------------------------
//
// Configuration numbers are BSON doubles by convention but hand-edited
// documents carry int32/int64/strings. These mirror the C# driver's
// permissive deserializers: read almost anything, produce a number.

func mFloat(m bson.M, key string, def float64) float64 {
	v, ok := m[key]
	if !ok || v == nil {
		return def
	}
	switch t := v.(type) {
	case float64:
		return t
	case float32:
		return float64(t)
	case int32:
		return float64(t)
	case int64:
		return float64(t)
	case int:
		return float64(t)
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(t), 64); err == nil {
			return f
		}
	}
	return def
}

func mInt(m bson.M, key string, def int) int {
	return int(mFloat(m, key, float64(def)))
}

func mString(m bson.M, key string, def string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return def
	}
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'G', -1, 64)
	case int32:
		return strconv.Itoa(int(t))
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		return strconv.FormatBool(t)
	case bson.ObjectID:
		return t.Hex()
	}
	return def
}

func mBool(m bson.M, key string, def bool) bool {
	v, ok := m[key]
	if !ok || v == nil {
		return def
	}
	switch t := v.(type) {
	case bool:
		return t
	case float64:
		return t != 0
	case int32:
		return t != 0
	case int64:
		return t != 0
	case string:
		if b, err := strconv.ParseBool(strings.TrimSpace(t)); err == nil {
			return b
		}
	}
	return def
}

func mStrings(m bson.M, key string) []string {
	v, ok := m[key]
	if !ok || v == nil {
		return nil
	}
	arr, ok := v.(bson.A)
	if !ok {
		if s, isStr := v.(string); isStr {
			return []string{s}
		}
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, e := range arr {
		if s, isStr := e.(string); isStr {
			out = append(out, s)
		}
	}
	return out
}

func mTime(m bson.M, key string) time.Time {
	v, ok := m[key]
	if !ok || v == nil {
		return time.Time{}
	}
	switch t := v.(type) {
	case time.Time:
		return t
	case bson.DateTime:
		return t.Time()
	case int64:
		return time.UnixMilli(t)
	}
	return time.Time{}
}

// mRaw returns a field exactly as it was stored, so a value copied into a
// command document keeps the BSON type the source tag had.
func mRaw(m bson.M, key string, def any) any {
	if v, ok := m[key]; ok && v != nil {
		return v
	}
	return def
}

// connectionFromDoc maps a protocolConnections document onto the runtime
// struct, applying the same defaults as the C# BsonDefaultValue attributes.
func connectionFromDoc(doc bson.M) *ServerConnection {
	c := &ServerConnection{
		ProtocolDriver:                mString(doc, "protocolDriver", ""),
		ProtocolDriverInstanceNumber:  mInt(doc, "protocolDriverInstanceNumber", 1),
		ProtocolConnectionNumber:      mInt(doc, "protocolConnectionNumber", 1),
		Name:                          mString(doc, "name", "NO NAME"),
		Description:                   mString(doc, "description", "SERVER NOT DESCRIPTED"),
		Enabled:                       mBool(doc, "enabled", true),
		CommandsEnabled:               mBool(doc, "commandsEnabled", true),
		IPAddressLocalBind:            mString(doc, "ipAddressLocalBind", "0.0.0.0:102"),
		IPAddresses:                   mStrings(doc, "ipAddresses"),
		Topics:                        mStrings(doc, "topics"),
		ServerModeMultiActive:         mBool(doc, "serverModeMultiActive", true),
		MaxClientConnections:          mFloat(doc, "maxClientConnections", 1),
		MaxQueueSize:                  mFloat(doc, "maxQueueSize", 5000),
		UseSecurity:                   mBool(doc, "useSecurity", false),
		LocalCertFilePath:             mString(doc, "localCertFilePath", ""),
		PrivateKeyFilePath:            mString(doc, "privateKeyFilePath", ""),
		PeerCertFilesPaths:            mStrings(doc, "peerCertFilesPaths"),
		RootCertFilePath:              mString(doc, "rootCertFilePath", ""),
		ChainValidation:               mBool(doc, "chainValidation", false),
		AllowOnlySpecificCertificates: mBool(doc, "allowOnlySpecificCertificates", false),
		AllowTLSv10:                   mBool(doc, "allowTLSv10", false),
		AllowTLSv11:                   mBool(doc, "allowTLSv11", false),
		AllowTLSv12:                   mBool(doc, "allowTLSv12", true),
		AllowTLSv13:                   mBool(doc, "allowTLSv13", true),
		CipherList:                    mString(doc, "cipherList", ""),
		Username:                      mString(doc, "username", ""),
		Password:                      mString(doc, "password", ""),
	}
	if id, ok := doc["_id"].(bson.ObjectID); ok {
		c.ID = id
	}
	return c
}

// instanceFromDoc maps a protocolDriverInstances document.
func instanceFromDoc(doc bson.M) *ProtocolDriverInstance {
	inst := &ProtocolDriverInstance{
		ProtocolDriver:                   mString(doc, "protocolDriver", ""),
		ProtocolDriverInstanceNumber:     mInt(doc, "protocolDriverInstanceNumber", 1),
		Enabled:                          mBool(doc, "enabled", true),
		LogLevel:                         mInt(doc, "logLevel", 1),
		NodeNames:                        mStrings(doc, "nodeNames"),
		ActiveNodeName:                   mString(doc, "activeNodeName", ""),
		ActiveNodeKeepAliveTimeTag:       mTime(doc, "activeNodeKeepAliveTimeTag"),
		KeepProtocolRunningWhileInactive: mBool(doc, "keepProtocolRunningWhileInactive", false),
	}
	if id, ok := doc["_id"].(bson.ObjectID); ok {
		inst.ID = id
	}
	return inst
}

// nodeAllowed reports whether this node may run the instance: an empty
// nodeNames list means any node.
func nodeAllowed(inst *ProtocolDriverInstance, nodeName string) bool {
	if len(inst.NodeNames) == 0 {
		return true
	}
	for _, n := range inst.NodeNames {
		if n == nodeName {
			return true
		}
	}
	return false
}
