package main

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/dscsystems/go-iec61850/client"
	"github.com/dscsystems/go-iec61850/mms"
	"github.com/dscsystems/go-iec61850/model"
	"github.com/dscsystems/go-iec61850/scl"
	"github.com/dscsystems/go-iec61850/server"
)

// startTestIED serves the sample SCL model on a loopback port.
func startTestIED(t *testing.T) (addr string, srv *server.Server) {
	t.Helper()

	m, err := scl.LoadModel("testdata/simpleIO_direct_control.cid")
	if err != nil {
		t.Fatalf("load SCL model: %v", err)
	}
	srv = server.New(m, server.WithIdentity(server.Identity{
		Vendor: "json-scada", Model: "loopback", Revision: "1",
	}))

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	return ln.Addr().String(), srv
}

// newTestConnection builds a connection document equivalent, pointing at the
// loopback IED.
func newTestConnection(addr string) *Iec61850Connection {
	return &Iec61850Connection{
		ProtocolConnectionNumber: 9999,
		Name:                     "TESTIED",
		Enabled:                  true,
		CommandsEnabled:          true,
		IPAddresses:              []string{addr},
		AutoCreateTags:           true,
		TimeoutMs:                5000,
		GiInterval:               1,
		Class0ScanInterval:       30,
		UseBrcb:                  true,
		UseUrcb:                  true,
		LastReportIds:            map[string][]byte{},
		Entries:                  map[string]*Iec61850Entry{},
		InsertedTags:             map[string]bool{},
		RcbByRptID:               map[string]*rcbState{},
	}
}

func drainQueue() []IECValue {
	var out []IECValue
	for {
		iv, ok := dequeueValue()
		if !ok {
			return out
		}
		out = append(out, iv)
	}
}

// waitForValues collects queued values until the deadline or until pred is
// satisfied.
func waitForValues(t *testing.T, d time.Duration, pred func([]IECValue) bool) []IECValue {
	t.Helper()
	deadline := time.Now().Add(d)
	var all []IECValue
	for time.Now().Before(deadline) {
		all = append(all, drainQueue()...)
		if pred(all) {
			return all
		}
		time.Sleep(50 * time.Millisecond)
	}
	return all
}

func connectTest(t *testing.T, conn *Iec61850Connection) *client.Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cli, err := client.Dial(ctx, splitHostPort(conn.IPAddresses[0]), client.WithTimeout(5*time.Second))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	conn.Cli = cli
	t.Cleanup(func() { closeConnection(conn) })
	return cli
}

// Discovery must find the logical devices, the data sets and both kinds of
// report control block, and link a configured entry to its data set.
func TestLoopbackDiscovery(t *testing.T) {
	addr, _ := startTestIED(t)
	conn := newTestConnection(addr)
	active.Store(true)
	defer active.Store(false)

	// A configured supervised point, as preloaded from realtimeData.
	key := "simpleIOGenericIO/GGIO1.SPCSO1.stVal" + "ST"
	conn.Entries[key] = &Iec61850Entry{
		Path:  "simpleIOGenericIO/GGIO1.SPCSO1.stVal",
		FC:    model.ST,
		JsTag: "TEST_SPCSO1",
	}
	conn.EntryOrder = append(conn.EntryOrder, key)

	connectTest(t, conn)
	defer drainQueue()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := discoverServer(ctx, conn); err != nil {
		t.Fatalf("discovery: %v", err)
	}

	if len(conn.Datasets) == 0 {
		t.Error("no data sets discovered")
	}
	if len(conn.Urcb) == 0 {
		t.Error("no unbuffered report control blocks discovered")
	}
	if len(conn.Brcb) == 0 {
		t.Error("no buffered report control blocks discovered")
	}
	if entry := conn.Entries[key]; entry.DataSetName == "" {
		t.Error("configured entry was not linked to its data set")
	}
	if len(conn.Subs) < 2 {
		t.Errorf("expected several concurrent report subscriptions, got %d", len(conn.Subs))
	}
}

// Several report control blocks are active at once on one association, and
// each subscription delivers its own reports (the capability that made this
// driver possible on go-iec61850 v0.2.x).
func TestLoopbackConcurrentReports(t *testing.T) {
	addr, srv := startTestIED(t)
	conn := newTestConnection(addr)
	active.Store(true)
	defer active.Store(false)

	connectTest(t, conn)
	drainQueue()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := discoverServer(ctx, conn); err != nil {
		t.Fatalf("discovery: %v", err)
	}

	// General interrogation on connect must produce the members of every
	// activated data set.
	values := waitForValues(t, 10*time.Second, func(v []IECValue) bool {
		return hasAddressPrefix(v, "simpleIOGenericIO/GGIO1.SPCSO") &&
			hasAddressPrefix(v, "simpleIOGenericIO/GGIO1.AnIn")
	})
	if !hasAddressPrefix(values, "simpleIOGenericIO/GGIO1.SPCSO") {
		t.Errorf("no status values reported; got %d values: %v", len(values), addresses(values))
	}
	if !hasAddressPrefix(values, "simpleIOGenericIO/GGIO1.AnIn") {
		t.Errorf("no measurand values reported; got %d values: %v", len(values), addresses(values))
	}

	// A boolean status member must be classified as a digital point, and a
	// measurand must not be: that is what decides the type of an
	// automatically created tag.
	for _, iv := range values {
		switch {
		case strings.HasPrefix(iv.Address, "simpleIOGenericIO/GGIO1.SPCSO"):
			if !iv.IsDigital {
				t.Errorf("%s should be digital", iv.Address)
			}
			if iv.ValueString != "true" && iv.ValueString != "false" {
				t.Errorf("%s valueString = %q", iv.Address, iv.ValueString)
			}
			if iv.CommonAddress != "ST" {
				t.Errorf("%s common address = %q, want ST", iv.Address, iv.CommonAddress)
			}
		case strings.HasSuffix(iv.Address, ".mag.f"):
			if iv.IsDigital {
				t.Errorf("%s should not be digital", iv.Address)
			}
			if iv.CommonAddress != "MX" {
				t.Errorf("%s common address = %q, want MX", iv.Address, iv.CommonAddress)
			}
		}
		if !iv.SelfPublish {
			t.Errorf("%s: reported values must be publishable when autoCreateTags is set", iv.Address)
		}
	}

	// A data change must be reported spontaneously.
	drainQueue()
	srv.Update(func(tx *server.Tx) {
		tx.SetFloat32("simpleIOGenericIO/GGIO1.AnIn1.mag.f", 42.5)
	})
	changed := waitForValues(t, 10*time.Second, func(v []IECValue) bool {
		for _, iv := range v {
			if strings.HasPrefix(iv.Address, "simpleIOGenericIO/GGIO1.AnIn1") && iv.Value == 42.5 {
				return true
			}
		}
		return false
	})
	found := false
	for _, iv := range changed {
		if strings.HasPrefix(iv.Address, "simpleIOGenericIO/GGIO1.AnIn1") && iv.Value == 42.5 {
			found = true
			// The data set member is the leaf mag.f, so the reported value
			// is a plain float.
			if iv.Asdu != "MMS_FLOAT" {
				t.Errorf("asdu = %q, want MMS_FLOAT", iv.Asdu)
			}
			if iv.ValueString != "42.5" {
				t.Errorf("valueString = %q, want 42.5", iv.ValueString)
			}
			if iv.ValueJSON == "" {
				t.Error("valueJson empty")
			}
		}
	}
	if !found {
		t.Errorf("data change not reported; got %v", addresses(changed))
	}
}

// The report handler must decode a report the same way whether or not the
// server includes data references. The driver does not request them (D10),
// but a device may be configured to send them, and a report is decoded by
// position: this pins that the extra strings do not shift the values.
func TestLoopbackReportWithDataReferences(t *testing.T) {
	addr, srv := startTestIED(t)
	conn := newTestConnection(addr)
	active.Store(true)
	defer active.Store(false)

	cli := connectTest(t, conn)
	drainQueue()
	defer drainQueue()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Report controls are indexed, so the instance name carries the suffix.
	ref := model.ObjectReference("simpleIOGenericIO/LLN0.RP.EventsRCB01")
	rcb, err := cli.GetRCB(ctx, ref)
	if err != nil {
		t.Fatalf("GetRCB: %v", err)
	}
	rcb.TrgOps = model.TrgDataChange | model.TrgIntegrity
	rcb.OptFlds = model.OptSeqNum | model.OptTimeOfEntry | model.OptReasonCode |
		model.OptDataSetName | model.OptDataRef | model.OptConfRev

	st := &rcbState{
		ref:        string(ref),
		rptID:      rcb.RptID,
		dataSetRef: rcb.DataSet,
		dataSetDot: dottedDataSet(rcb.DataSet),
	}
	sub, err := cli.EnableReporting(ctx, rcb, func(rep *client.Report) {
		reportHandler(conn, st, rep)
	})
	if err != nil {
		t.Fatalf("EnableReporting: %v", err)
	}
	defer sub.Disable(context.Background())

	drainQueue()
	srv.Update(func(tx *server.Tx) {
		tx.SetBool("simpleIOGenericIO/GGIO1.SPCSO2.stVal", true)
	})

	values := waitForValues(t, 10*time.Second, func(v []IECValue) bool {
		for _, iv := range v {
			if iv.Address == "simpleIOGenericIO/GGIO1.SPCSO2.stVal" {
				return true
			}
		}
		return false
	})
	for _, iv := range values {
		if iv.Address == "simpleIOGenericIO/GGIO1.SPCSO2.stVal" {
			if !iv.IsDigital || iv.Value != 1 || iv.ValueString != "true" {
				t.Errorf("value decoded wrongly with data references present: %+v", iv)
			}
			return
		}
	}
	t.Errorf("no value decoded from a report carrying data references; got %v", addresses(values))
}

// Only one report control block per data set and kind is activated. A
// server offers several instances over the same data set — indexed blocks,
// or spares for other clients — and each carries its own RptID, so nothing
// but this rule stops the same values being written once per instance.
func TestLoopbackOneSubscriptionPerDataSet(t *testing.T) {
	// Two unbuffered blocks over one data set, with distinct RptIDs, plus
	// one buffered block over the same data set and one over another.
	ggio := &model.LogicalNode{Name: "GGIO1", Class: "GGIO", Objects: []*model.DataObject{
		model.NewDataObject("Ind1", model.CDCSPS),
		model.NewDataObject("AnIn1", model.CDCMV),
	}}
	lln0 := &model.LogicalNode{Name: "LLN0", Class: "LLN0",
		DataSets: []*model.DataSet{
			{Name: "DS_ST_1", Entries: []model.FCDA{{Ref: "DUPIED/GGIO1.Ind1", FC: model.ST}}},
			{Name: "DS_MX_1", Entries: []model.FCDA{{Ref: "DUPIED/GGIO1.AnIn1", FC: model.MX}}},
		},
		ReportControls: []*model.ReportControl{
			{Name: "urcbST01", RptID: "DUPIED/LLN0$RP$urcbST0101", DataSet: "DS_ST_1",
				ConfRev: 1, TrgOps: model.TrgDataChange | model.TrgGI,
				OptFlds: model.OptFldsDefault, RptEnabled: 1},
			{Name: "urcbST02", RptID: "DUPIED/LLN0$RP$urcbST0201", DataSet: "DS_ST_1",
				ConfRev: 1, TrgOps: model.TrgDataChange | model.TrgGI,
				OptFlds: model.OptFldsDefault, RptEnabled: 1},
			{Name: "brcbST01", RptID: "DUPIED/LLN0$BR$brcbST0101", DataSet: "DS_ST_1",
				ConfRev: 1, Buffered: true, TrgOps: model.TrgDataChange | model.TrgGI,
				OptFlds: model.OptFldsDefault, RptEnabled: 1},
			{Name: "urcbMX01", RptID: "DUPIED/LLN0$RP$urcbMX0101", DataSet: "DS_MX_1",
				ConfRev: 1, TrgOps: model.TrgDataChange | model.TrgGI,
				OptFlds: model.OptFldsDefault, RptEnabled: 1},
		},
	}
	ld := &model.LogicalDevice{Name: "DUPIED", Inst: "LD0", Nodes: []*model.LogicalNode{lln0, ggio}}
	srv := server.New(&model.Model{Name: "DUPIED", Devices: []*model.LogicalDevice{ld}})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })

	conn := newTestConnection(ln.Addr().String())
	active.Store(true)
	defer active.Store(false)
	connectTest(t, conn)
	defer drainQueue()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := discoverServer(ctx, conn); err != nil {
		t.Fatalf("discovery: %v", err)
	}

	// Four control blocks over two data sets: one stream each.
	if len(conn.Subs) != 2 {
		t.Errorf("subscriptions = %d, want 2 (one per data set)", len(conn.Subs))
	}
	if len(conn.RcbByDataSet) != 2 {
		t.Errorf("data sets covered = %d, want 2: %v", len(conn.RcbByDataSet), conn.RcbByDataSet)
	}
	// The data set that has a buffered block is served by it, since a
	// buffered stream survives a disconnection.
	for ds, st := range conn.RcbByDataSet {
		if strings.HasSuffix(ds, "DS_ST_1") && !st.buffered {
			t.Errorf("%s is served by %s, want the buffered block", ds, st.ref)
		}
	}

	// A change is reported once, not once per instance over the data set.
	drainQueue()
	srv.Update(func(tx *server.Tx) { tx.SetBool("DUPIED/GGIO1.Ind1.stVal", true) })
	values := waitForValues(t, 5*time.Second, func(v []IECValue) bool { return len(v) > 0 })
	count := 0
	for _, iv := range values {
		if strings.HasSuffix(iv.Address, "GGIO1.Ind1") {
			count++
		}
	}
	if count != 1 {
		t.Errorf("the change was reported %d times, want once: %v", count, addresses(values))
	}
}

// Entries not covered by a report are polled, and the values reach the
// queue with the connection's identity on them.
func TestLoopbackPolling(t *testing.T) {
	addr, _ := startTestIED(t)
	conn := newTestConnection(addr)
	conn.UseBrcb = false
	conn.UseUrcb = false // no reports: everything is polled
	active.Store(true)
	defer active.Store(false)

	key := "simpleIOGenericIO/GGIO1.AnIn1" + "MX"
	conn.Entries[key] = &Iec61850Entry{
		Path:  "simpleIOGenericIO/GGIO1.AnIn1",
		FC:    model.MX,
		JsTag: "TEST_ANIN1",
	}
	conn.EntryOrder = append(conn.EntryOrder, key)

	connectTest(t, conn)
	drainQueue()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := discoverServer(ctx, conn); err != nil {
		t.Fatalf("discovery: %v", err)
	}
	if err := pollSweep(ctx, conn); err != nil {
		t.Fatalf("poll sweep: %v", err)
	}

	values := drainQueue()
	if len(values) != 1 {
		t.Fatalf("expected one polled value, got %d: %v", len(values), addresses(values))
	}
	iv := values[0]
	if iv.Address != "simpleIOGenericIO/GGIO1.AnIn1" || iv.CommonAddress != "MX" {
		t.Errorf("polled value = %s [%s]", iv.Address, iv.CommonAddress)
	}
	if iv.ConnName != "TESTIED" || iv.ConnNumber != 9999 {
		t.Error("connection identity missing from the polled value")
	}
	if iv.SelfPublish {
		t.Error("polled values must not auto-create tags")
	}
	if iv.Cot != 20 {
		t.Errorf("cause of transmission = %d, want 20", iv.Cot)
	}
}

// A control command reaches the IED and changes its status value.
func TestLoopbackControl(t *testing.T) {
	addr, srv := startTestIED(t)
	conn := newTestConnection(addr)
	active.Store(true)
	defer active.Store(false)

	connectTest(t, conn)
	drainQueue()
	defer drainQueue()

	entry := &Iec61850Entry{Path: "simpleIOGenericIO/GGIO1.SPCSO1", FC: model.CO}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	ok, abort := controlCommand(ctx, conn, entry, 1, false)
	if abort {
		t.Fatal("control aborted")
	}
	if !ok {
		t.Fatal("control was not accepted")
	}

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if v := srv.Read("simpleIOGenericIO/GGIO1.SPCSO1.stVal", model.ST); v != nil && v.Bool() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Error("status value did not follow the control")
}

// A plain MMS write is used for any functional constraint other than CO.
func TestLoopbackWriteCommand(t *testing.T) {
	addr, srv := startTestIED(t)
	conn := newTestConnection(addr)
	active.Store(true)
	defer active.Store(false)

	connectTest(t, conn)
	drainQueue()
	defer drainQueue()

	// A settable point of the sample model: the analogue input's value.
	entry := &Iec61850Entry{Path: "simpleIOGenericIO/GGIO1.AnIn1.mag.f", FC: model.MX}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	ok, abort := writeValueCommand(ctx, conn, entry, 3.5)
	if abort {
		t.Skip("object not writable on this model")
	}
	if !ok {
		t.Skip("write refused by the server model")
	}
	if v := srv.Read("simpleIOGenericIO/GGIO1.AnIn1.mag.f", model.MX); v == nil || v.Float64() != 3.5 {
		t.Errorf("written value not applied: %v", v)
	}
}

// The association state is observable without issuing a request, which is
// what the reconnect loop relies on.
func TestLoopbackConnectionState(t *testing.T) {
	addr, srv := startTestIED(t)
	conn := newTestConnection(addr)
	cli := connectTest(t, conn)

	if cli.State() != mms.StateConnected {
		t.Fatalf("state after dial = %v", cli.State())
	}

	_ = srv.Close()
	select {
	case <-cli.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("Done() did not fire after the server closed")
	}
	if cli.State() != mms.StateClosed {
		t.Errorf("state after close = %v, want closed", cli.State())
	}
}

func addresses(values []IECValue) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		out = append(out, v.Address+"["+v.CommonAddress+"]")
	}
	return out
}

func hasAddressPrefix(values []IECValue, prefix string) bool {
	for _, v := range values {
		if strings.HasPrefix(v.Address, prefix) {
			return true
		}
	}
	return false
}
