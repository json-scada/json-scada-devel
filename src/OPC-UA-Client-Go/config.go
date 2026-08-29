/*
 * OPC-UA Client Protocol driver for {json:scada}, in Go.
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

// Documents, permissive BSON decoding and the MongoDB connection.
// Port of Common_srv_cli.cs.

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gopcua/opcua"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Driver identity, matching the C# driver so the same instance and
// connection documents drive either binary.
const (
	CopyrightMessage   = "{json:scada} OPC-UA Client Driver (Go) - Copyright 2020-2026 Ricardo L. Olsen"
	ProtocolDriverName = "OPC-UA"
	DriverVersion      = "0.1.0"
	LibraryVersion     = "gopcua v0.9.1"
)

// Collection names.
const (
	ProtocolConnectionsCollectionName     = "protocolConnections"
	ProtocolDriverInstancesCollectionName = "protocolDriverInstances"
	RealtimeDataCollectionName            = "realtimeData"
	CommandsQueueCollectionName           = "commandsQueue"
)

// Queue and key-allocation limits, same values as the C# driver.
const (
	DataBufferLimit   = 50000   // stop enqueuing acquired values above this
	BulkWriteLimit    = 6000    // maximum write models per bulk write
	AutoKeyMultiplier = 1000000 // _id range reserved per connection for auto-created tags
	PointKeyInsert    = 100000  // kept for parity with the C# driver (unused)
)

// Default config file locations, in the C# driver's resolution order.
const (
	JSONConfigFilePath    = "../conf/json-scada.json"
	JSONConfigFilePathAlt = "c:/json-scada/conf/json-scada.json"
)

// active is set by the redundancy loop; only command execution honours it.
//
// parity: the C# driver acquires data and writes it to MongoDB on both the
// active and the standby node — ProcessMongo and the OPC UA session never
// look at Active. Reproduced here on purpose; see deviation D9 in README.md.
var active atomic.Bool

// Counters reported by the redundancy loop, as in the C# driver.
var (
	CntNotificEvents   atomic.Uint64
	CntLostDataUpdates atomic.Uint64
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

// NodeDetails is what browsing learned about a node, kept so the MongoDB
// writer can fill in the tag document of a value that arrived through a
// subscription notification (which carries neither path nor parent).
// Port of the NodeDetails class of AsduReceiveHandler.cs.
type NodeDetails struct {
	DisplayName string
	BrowseName  string
	ParentName  string
	Path        string
}

// monItem is one monitored item: the OPC UA subscription reports values by
// ClientHandle only, so the driver owns the mapping back to the address and
// the display name.
//
// The C# driver builds two parallel objects for a preconfigured tag (an
// rtMonitTag and a MonitoredItem) carrying identical parameters; one struct
// serves both roles here.
type monItem struct {
	// NodeID is the address exactly as it must appear in
	// protocolSourceObjectAddress. For a preconfigured tag it is the
	// verbatim string from the document, never a re-rendered NodeID, or
	// the update filter would stop matching.
	NodeID      string
	DisplayName string
	SamplingMs  float64
	QueueSize   uint32
	Handle      uint32
}

// OPCUAConnection is a document of protocolConnections plus the runtime
// state of the session it describes.
type OPCUAConnection struct {
	ID                              bson.ObjectID
	ProtocolDriver                  string
	ProtocolDriverInstanceNumber    int
	ProtocolConnectionNumber        int
	Name                            string
	Description                     string
	Enabled                         bool
	CommandsEnabled                 bool
	EndpointURLs                    []string
	ConfigFileName                  string
	AutoCreateTags                  bool
	AutoCreateTagPublishingInterval float64
	AutoCreateTagSamplingInterval   float64
	AutoCreateTagQueueSize          float64
	TimeoutMs                       float64
	UseSecurity                     bool
	HoursShift                      float64
	GiInterval                      float64 // parity: declared, never used (deviation D12)
	Topics                          []string
	Username                        string
	Password                        string
	PfxFilePath                     string
	Passphrase                      string
	LocalCertFilePath               string
	SecurityMode                    string
	SecurityPolicy                  string
	AutoAcceptUntrustedCertificates bool

	// Runtime state, guarded by mu: the connection goroutine writes it
	// while the MongoDB writer and the command dispatcher read it.
	mu                sync.Mutex
	InsertedAddresses map[string]bool
	NodeIdsDetails    map[string]*NodeDetails
	LastNewKeyCreated float64
	handles           map[uint32]*monItem
	nextHandle        uint32
	client            *opcua.Client

	// ListMon holds every monitored item of the connection, preconfigured
	// ones first. It is the subscription content when autoCreateTags is
	// on; OpcSubscriptions is used instead when it is off.
	ListMon []*monItem

	// OpcSubscriptions groups preconfigured items by their publishing
	// interval in seconds. SubscriptionOrder keeps the order the intervals
	// were first seen, so subscriptions are created deterministically.
	OpcSubscriptions  map[float64][]*monItem
	SubscriptionOrder []float64
}

// OPCValue is one acquired value on its way to MongoDB.
// Port of the OPC_Value class of Common_srv_cli.cs.
type OPCValue struct {
	CreateCommandForMethod     bool
	CreateCommandForSupervised bool
	AccessLevels               byte
	ValueJSON                  string
	SelfPublish                bool
	Address                    string
	Asdu                       string
	IsArray                    bool
	Value                      float64
	ValueString                string
	Cot                        int
	ServerTimestamp            time.Time
	SourceTimestamp            time.Time
	HasSourceTimestamp         bool
	Quality                    bool
	ConnNumber                 int
	ConnName                   string
	CommonAddress              string
	DisplayName                string
	ParentName                 string
	Path                       string
}

// --- connection runtime accessors ----------------------------------------

// AddInsertedAddress records an address as present in realtimeData and
// reports whether it was new, like SortedSet<string>.Add in C#.
func (c *OPCUAConnection) AddInsertedAddress(addr string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.InsertedAddresses[addr] {
		return false
	}
	c.InsertedAddresses[addr] = true
	return true
}

// HasInsertedAddress reports whether the address already has a tag.
func (c *OPCUAConnection) HasInsertedAddress(addr string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.InsertedAddresses[addr]
}

// SetNodeDetails records what browsing learned about a node.
func (c *OPCUAConnection) SetNodeDetails(nodeID string, d *NodeDetails) {
	c.mu.Lock()
	c.NodeIdsDetails[nodeID] = d
	c.mu.Unlock()
}

// NodeDetailsFor returns what browsing learned about a node, if anything.
func (c *OPCUAConnection) NodeDetailsFor(nodeID string) (*NodeDetails, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	d, ok := c.NodeIdsDetails[nodeID]
	return d, ok
}

// NewHandle allocates a client handle for a monitored item and registers
// it, so notifications can be mapped back to the address.
func (c *OPCUAConnection) NewHandle(it *monItem) uint32 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.nextHandle++
	it.Handle = c.nextHandle
	c.handles[it.Handle] = it
	return it.Handle
}

// ItemForHandle resolves the monitored item a notification belongs to.
func (c *OPCUAConnection) ItemForHandle(h uint32) *monItem {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.handles[h]
}

// TagKeyStarted reports whether the _id allocator has been seeded from the
// database yet.
//
// parity: the C# driver uses LastNewKeyCreated == 0 as that sentinel, which
// is safe because the first key of a connection is its number times a
// million.
func (c *OPCUAConnection) TagKeyStarted() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.LastNewKeyCreated != 0
}

// SetTagKey seeds the _id allocator with the first key to use.
func (c *OPCUAConnection) SetTagKey(v float64) {
	c.mu.Lock()
	c.LastNewKeyCreated = v
	c.mu.Unlock()
}

// BumpTagKey advances the allocator and returns the next key.
func (c *OPCUAConnection) BumpTagKey() float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.LastNewKeyCreated++
	return c.LastNewKeyCreated
}

// ResetDiscovery drops everything the last discovery built, so the tags can
// be reloaded from the database and browsing can start over.
func (c *OPCUAConnection) ResetDiscovery() {
	c.mu.Lock()
	c.ListMon = nil
	c.OpcSubscriptions = map[float64][]*monItem{}
	c.SubscriptionOrder = nil
	c.InsertedAddresses = map[string]bool{}
	c.NodeIdsDetails = map[string]*NodeDetails{}
	c.handles = map[uint32]*monItem{}
	c.nextHandle = 0
	// Forces the _id allocator to look up the highest key again, which a
	// partially completed pass will have moved.
	c.LastNewKeyCreated = 0
	c.mu.Unlock()
}

// CommitPreloadedTags installs the tags read from realtimeData.
func (c *OPCUAConnection) CommitPreloadedTags(listMon []*monItem, subs map[float64][]*monItem, order []float64, addrs map[string]bool) {
	c.mu.Lock()
	c.ListMon = listMon
	c.OpcSubscriptions = subs
	c.SubscriptionOrder = order
	c.InsertedAddresses = addrs
	c.mu.Unlock()
}

// Client returns the session, which the command dispatcher reads while the
// connection goroutine may be replacing it.
func (c *OPCUAConnection) Client() *opcua.Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.client
}

// setClient stores the session, or clears it when the connection is down.
// Clearing also drops the monitored item handles: the next session issues
// its own, and a stale handle would resolve to the wrong item.
func (c *OPCUAConnection) setClient(cli *opcua.Client) {
	c.mu.Lock()
	c.client = cli
	if cli == nil {
		c.handles = map[uint32]*monItem{}
		c.nextHandle = 0
	}
	c.mu.Unlock()
}

// --- startup configuration -----------------------------------------------

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

	Log(LogLevelNoLog, "%s", CopyrightMessage)
	Log(LogLevelNoLog, "Driver version %s", DriverVersion)
	Log(LogLevelNoLog, "Using the gopcua library, %s.", LibraryVersion)
	Log(LogLevelNoLog, "Log level: %d", LogLevel)

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
	Log(LogLevelNoLog, "MongoDB database name: %s", cfg.MongoDatabaseName)
	if cfg.NodeName == "" {
		Fatal("Missing nodeName parameter in JSON config file %s", fname)
	}
	Log(LogLevelNoLog, "Node name: %s", cfg.NodeName)

	return cfg, instanceNumber
}

// mongoConnect opens a MongoDB client, applying the TLS options of the
// json-scada config as URI parameters (same approach as the other Go
// drivers).
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
// BsonDoubleSerializer: read almost anything, produce a number.

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
	case bson.Decimal128:
		if f, err := strconv.ParseFloat(t.String(), 64); err == nil {
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

// --- document mapping ----------------------------------------------------

// connectionFromDoc maps a protocolConnections document onto the runtime
// struct, applying the same defaults as the C# BsonDefaultValue attributes.
func connectionFromDoc(doc bson.M) *OPCUAConnection {
	c := &OPCUAConnection{
		ProtocolDriver:                  mString(doc, "protocolDriver", ""),
		ProtocolDriverInstanceNumber:    mInt(doc, "protocolDriverInstanceNumber", 1),
		ProtocolConnectionNumber:        mInt(doc, "protocolConnectionNumber", 1),
		Name:                            mString(doc, "name", "NO NAME"),
		Description:                     mString(doc, "description", "SERVER NOT DESCRIPTED"),
		Enabled:                         mBool(doc, "enabled", true),
		CommandsEnabled:                 mBool(doc, "commandsEnabled", true),
		EndpointURLs:                    mStrings(doc, "endpointURLs"),
		ConfigFileName:                  mString(doc, "configFileName", "../conf/Opc.Ua.DefaultClient.Config.xml"),
		AutoCreateTags:                  mBool(doc, "autoCreateTags", true),
		AutoCreateTagPublishingInterval: mFloat(doc, "autoCreateTagPublishingInterval", 5.0),
		AutoCreateTagSamplingInterval:   mFloat(doc, "autoCreateTagSamplingInterval", 5.0),
		AutoCreateTagQueueSize:          mFloat(doc, "autoCreateTagQueueSize", 5.0),
		TimeoutMs:                       mFloat(doc, "timeoutMs", 20000),
		UseSecurity:                     mBool(doc, "useSecurity", false),
		HoursShift:                      mFloat(doc, "hoursShift", 0),
		GiInterval:                      mFloat(doc, "giInterval", 300),
		Topics:                          mStrings(doc, "topics"),
		Username:                        mString(doc, "username", ""),
		Password:                        mString(doc, "password", ""),
		PfxFilePath:                     mString(doc, "pfxFilePath", ""),
		Passphrase:                      mString(doc, "passphrase", ""),
		LocalCertFilePath:               mString(doc, "localCertFilePath", ""),
		SecurityMode:                    mString(doc, "securityMode", "None"),
		SecurityPolicy:                  mString(doc, "securityPolicy", "None"),
		AutoAcceptUntrustedCertificates: mBool(doc, "autoAcceptUntrustedCertificates", true),

		InsertedAddresses: map[string]bool{},
		NodeIdsDetails:    map[string]*NodeDetails{},
		OpcSubscriptions:  map[float64][]*monItem{},
		handles:           map[uint32]*monItem{},
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

// connByNumber finds a connection by its protocolConnectionNumber.
func connByNumber(conns []*OPCUAConnection, number int) *OPCUAConnection {
	for _, c := range conns {
		if c.ProtocolConnectionNumber == number {
			return c
		}
	}
	return nil
}
