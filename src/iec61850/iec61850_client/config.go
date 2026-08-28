/*
 * IEC 61850 MMS Client driver for {json:scada}, in Go.
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
	"sync"
	"time"

	"github.com/dscsystems/go-iec61850/client"
	"github.com/dscsystems/go-iec61850/model"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Driver identity, matching the C# driver so the same instance and
// connection documents drive either binary.
const (
	CopyrightMessage   = "{json:scada} IEC61850 Client Driver (Go) - Copyright 2020-2026 Ricardo Olsen"
	ProtocolDriverName = "IEC61850"
	DriverVersion      = "0.1.0"
	LibraryVersion     = "v0.2.3"
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
	DataBufferLimit   = 20000   // discard oldest above this when MongoDB is down
	BulkWriteLimit    = 1250    // maximum write models per bulk write
	AutoKeyMultiplier = 1000000 // _id range reserved per connection for auto-created tags
	PointKeyInsert    = 100000  // kept for parity with the C# driver (unused)
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

// Iec61850Entry is one IEC 61850 object the driver reads or commands.
type Iec61850Entry struct {
	Path        string   // IEC 61850 object path, "LD/LN.DO[.DA]"
	FC          model.FC // functional constraint
	Childs      []string // names of the child attributes, when structured
	DataSetName string   // dataset containing the object, if any
	RcbName     string   // report control block reporting the object, if any
	JsTag       string   // json-scada tag to update (logging only for auto tags)

	// AutoPublish marks an entry the driver discovered itself, either by
	// browsing the server or from a report. Its values carry the
	// self-publish flag, so the writer creates the tag. Entries preloaded
	// from realtimeData already have a tag and never publish.
	AutoPublish bool
}

// Iec61850Connection is a document of protocolConnections plus the runtime
// state of the association it describes.
type Iec61850Connection struct {
	ID                            bson.ObjectID
	ProtocolDriver                string
	ProtocolDriverInstanceNumber  int
	ProtocolConnectionNumber      int
	Name                          string
	Description                   string
	Enabled                       bool
	CommandsEnabled               bool
	IPAddresses                   []string
	Topics                        []string
	AutoCreateTags                bool
	TimeoutMs                     float64
	Password                      string
	UseSecurity                   bool
	LocalCertFilePath             string
	PeerCertFilesPaths            []string
	RootCertFilePath              string
	ChainValidation               bool
	AllowOnlySpecificCertificates bool
	PrivateKeyFilePath            string
	CipherList                    string
	AllowTLSv10                   bool
	AllowTLSv11                   bool
	AllowTLSv12                   bool
	AllowTLSv13                   bool
	GiInterval                    float64
	Class0ScanInterval            float64
	UseBrcb                       bool
	UseUrcb                       bool
	Browse                        bool

	// Runtime state.
	mu                sync.Mutex
	LastReportIds     map[string][]byte // rcb reference -> last seen EntryID
	Entries           map[string]*Iec61850Entry
	EntryOrder        []string // stable iteration order for the polling sweep
	InsertedTags      map[string]bool
	LastNewKeyCreated float64
	Cli               *client.Client
	Subs              []*client.ReportSubscription
	RcbByRptID        map[string]*rcbState
	RcbByDataSet      map[string]*rcbState // data set -> the block reporting it
	Brcb              []string
	Urcb              []string
	Datasets          []string
	BrcbCount         int
}

// SetLastReportID records a buffered report's EntryID for resync.
func (c *Iec61850Connection) SetLastReportID(rcbRef string, entryID []byte) {
	c.mu.Lock()
	c.LastReportIds[rcbRef] = entryID
	c.BrcbCount++
	c.mu.Unlock()
}

// LastReportID returns the EntryID last seen on an RCB.
func (c *Iec61850Connection) LastReportID(rcbRef string) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	v, ok := c.LastReportIds[rcbRef]
	return v, ok
}

// SnapshotReportIDs copies the map for the redundancy writer.
func (c *Iec61850Connection) SnapshotReportIDs() map[string][]byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string][]byte, len(c.LastReportIds))
	for k, v := range c.LastReportIds {
		out[k] = v
	}
	return out
}

// Entry looks up a configured entry by object address and functional
// constraint, both as written in the tag document.
func (c *Iec61850Connection) Entry(key string) *Iec61850Entry {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Entries[key]
}

// Entry state is shared between the connection goroutine (discovery) and
// the association's reader goroutine (reports), so it is read and written
// through the connection lock.

// SetEntryDataSet records the data set an entry belongs to.
func (c *Iec61850Connection) SetEntryDataSet(e *Iec61850Entry, dataSet string) {
	c.mu.Lock()
	e.DataSetName = dataSet
	c.mu.Unlock()
}

// SetEntryReport records that an entry is delivered by a report, which
// takes it out of the polling sweep.
func (c *Iec61850Connection) SetEntryReport(e *Iec61850Entry, rcbName, dataSet string) {
	c.mu.Lock()
	e.RcbName = rcbName
	e.DataSetName = dataSet
	c.mu.Unlock()
}

// EntryHasReport reports whether an entry is covered by a report.
func (c *Iec61850Connection) EntryHasReport(e *Iec61850Entry) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return e.RcbName != ""
}

// EntryNeedsChilds reports whether the child attribute names of an entry
// are still unknown.
func (c *Iec61850Connection) EntryNeedsChilds(e *Iec61850Entry) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(e.Childs) == 0
}

// AddEntryChild records the name of a child attribute.
func (c *Iec61850Connection) AddEntryChild(e *Iec61850Entry, name string) {
	c.mu.Lock()
	e.Childs = append(e.Childs, name)
	c.mu.Unlock()
}

// AddEntryChildOnce records a child attribute name, keeping the order the
// server listed them in and ignoring repeats: a name list names an
// attribute once per leaf below it.
func (c *Iec61850Connection) AddEntryChildOnce(e *Iec61850Entry, name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, existing := range e.Childs {
		if existing == name {
			return
		}
	}
	e.Childs = append(e.Childs, name)
}

// EntryChilds copies the child attribute names, for logging.
func (c *Iec61850Connection) EntryChilds(e *Iec61850Entry) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), e.Childs...)
}

// Client returns the association, which the command goroutine reads while
// the connection goroutine may be replacing it.
func (c *Iec61850Connection) Client() *client.Client {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.Cli
}

// SetClient stores the association.
func (c *Iec61850Connection) SetClient(cli *client.Client) {
	c.mu.Lock()
	c.Cli = cli
	c.mu.Unlock()
}

// AddSubscription records an active report subscription.
func (c *Iec61850Connection) AddSubscription(sub *client.ReportSubscription) {
	c.mu.Lock()
	c.Subs = append(c.Subs, sub)
	c.mu.Unlock()
}

// TakeSubscriptions removes and returns the active subscriptions.
func (c *Iec61850Connection) TakeSubscriptions() []*client.ReportSubscription {
	c.mu.Lock()
	defer c.mu.Unlock()
	subs := c.Subs
	c.Subs = nil
	return subs
}

// AddEntry registers an entry discovered from a report (autoCreateTags) and
// returns the entry now in effect, which is the existing one if another
// report registered it first.
func (c *Iec61850Connection) AddEntry(key string, e *Iec61850Entry) *Iec61850Entry {
	c.mu.Lock()
	defer c.mu.Unlock()
	if existing, seen := c.Entries[key]; seen {
		return existing
	}
	c.Entries[key] = e
	c.EntryOrder = append(c.EntryOrder, key)
	return e
}

// IECValue is one acquired value on its way to MongoDB.
type IECValue struct {
	ValueJSON          string
	SelfPublish        bool
	Address            string
	Asdu               string
	IsDigital          bool
	IsTransient        bool
	Value              float64
	ValueString        string
	Cot                int
	ServerTimestamp    time.Time
	SourceTimestamp    time.Time
	HasSourceTimestamp bool
	Quality            bool
	ConnNumber         int
	ConnName           string
	CommonAddress      string
	DisplayName        string
}

// entryKey builds the map key used for configured entries: the object
// address concatenated with the functional constraint mnemonic, matching
// the C# driver's `dataRef + fc`.
func entryKey(path string, fc model.FC) string {
	return path + fc.String()
}

// parseFCOrST parses a functional constraint mnemonic. The C# driver uses
// Enum.TryParse, which leaves the zero value on failure, and libiec61850's
// FunctionalConstraint zero is ST — so an unparseable value means ST here
// too, not FCNone.
func parseFCOrST(s string) model.FC {
	fc, err := model.ParseFC(strings.ToUpper(strings.TrimSpace(s)))
	if err != nil || fc == model.FCNone {
		return model.ST
	}
	return fc
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

	Log(LogLevelNoLog, "%s", CopyrightMessage)
	Log(LogLevelNoLog, "Driver version %s", DriverVersion)
	Log(LogLevelNoLog, "Using go-iec61850 version %s", LibraryVersion)
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
// json-scada config as URI parameters (same approach as plc4x-client).
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

func mBinaryMap(m bson.M, key string) map[string][]byte {
	out := map[string][]byte{}
	v, ok := m[key]
	if !ok || v == nil {
		return out
	}
	doc, ok := v.(bson.M)
	if !ok {
		d, isD := v.(bson.D)
		if !isD {
			return out
		}
		doc = bson.M{}
		for _, e := range d {
			doc[e.Key] = e.Value
		}
	}
	for k, e := range doc {
		switch t := e.(type) {
		case bson.Binary:
			out[k] = t.Data
		case []byte:
			out[k] = t
		case bson.A:
			b := make([]byte, 0, len(t))
			for _, x := range t {
				b = append(b, byte(int(mFloatVal(x))))
			}
			out[k] = b
		}
	}
	return out
}

func mFloatVal(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int32:
		return float64(t)
	case int64:
		return float64(t)
	case int:
		return float64(t)
	}
	return 0
}

// connectionFromDoc maps a protocolConnections document onto the runtime
// struct, applying the same defaults as the C# BsonDefaultValue attributes.
func connectionFromDoc(doc bson.M) *Iec61850Connection {
	c := &Iec61850Connection{
		ProtocolDriver:                mString(doc, "protocolDriver", ""),
		ProtocolDriverInstanceNumber:  mInt(doc, "protocolDriverInstanceNumber", 1),
		ProtocolConnectionNumber:      mInt(doc, "protocolConnectionNumber", 1),
		Name:                          mString(doc, "name", "NO NAME"),
		Description:                   mString(doc, "description", "SERVER NOT DESCRIPTED"),
		Enabled:                       mBool(doc, "enabled", true),
		CommandsEnabled:               mBool(doc, "commandsEnabled", true),
		IPAddresses:                   mStrings(doc, "ipAddresses"),
		Topics:                        mStrings(doc, "topics"),
		AutoCreateTags:                mBool(doc, "autoCreateTags", true),
		TimeoutMs:                     mFloat(doc, "timeoutMs", 20000),
		Password:                      mString(doc, "password", ""),
		UseSecurity:                   mBool(doc, "useSecurity", false),
		LocalCertFilePath:             mString(doc, "localCertFilePath", ""),
		PeerCertFilesPaths:            mStrings(doc, "peerCertFilesPaths"),
		RootCertFilePath:              mString(doc, "rootCertFilePath", ""),
		ChainValidation:               mBool(doc, "chainValidation", false),
		AllowOnlySpecificCertificates: mBool(doc, "allowOnlySpecificCertificates", false),
		PrivateKeyFilePath:            mString(doc, "privateKeyFilePath", ""),
		CipherList:                    mString(doc, "cipherList", ""),
		AllowTLSv10:                   mBool(doc, "allowTLSv10", false),
		AllowTLSv11:                   mBool(doc, "allowTLSv11", false),
		AllowTLSv12:                   mBool(doc, "allowTLSv12", true),
		AllowTLSv13:                   mBool(doc, "allowTLSv13", true),
		GiInterval:                    mFloat(doc, "giInterval", 10),
		Class0ScanInterval:            mFloat(doc, "class0ScanInterval", 300),
		UseBrcb:                       mBool(doc, "useBrcb", true),
		UseUrcb:                       mBool(doc, "useUrcb", true),
		Browse:                        mBool(doc, "browse", false),
		LastReportIds:                 mBinaryMap(doc, "lastReportIds"),
		Entries:                       map[string]*Iec61850Entry{},
		InsertedTags:                  map[string]bool{},
		RcbByRptID:                    map[string]*rcbState{},
		RcbByDataSet:                  map[string]*rcbState{},
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
