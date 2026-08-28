package main

import (
	"net"
	"testing"
	"time"

	"github.com/riclolsen/tase2/tase2"
)

// TestServerLoopback drives the driver's server construction against a live
// tase2 client (no MongoDB needed): it verifies BLT topic isolation on
// discovery and reads, ICCP-typed value decoding, and the change-stream
// buffering path (pendingChangesMap + flushPendingChanges) delivering DSTS
// change reports to a subscribed client.
func TestServerLoopback(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("pick port: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()

	// ---- Data model built the same way main() builds it ----
	dataModel := tase2.NewDataModel()

	domA := dataModel.AddDomain("SUB_A")
	tagA := rtData{Tag: "KAW2TR1-0MTRP", Type: "analog", Value: 55.5, Group1: "SUB_A"}
	pointA := sanitizePointName(tagA.Tag)
	ipA := domA.AddDataPoint(pointA, tase2.ICCPTypeRealQTimeTag)
	ipA.UpdateValue(convertToICCPValue(tagA, tase2.ICCPTypeRealQTimeTag), nil)
	domA.AddDSTransferSet("DSTrans").AttachDataSet("SUB_A", "SUB_A_DataSet")

	domB := dataModel.AddDomain("SUB_B")
	tagB := rtData{Tag: "HIDDEN-POINT", Type: "analog", Value: 99.9, Group1: "SUB_B"}
	pointB := sanitizePointName(tagB.Tag)
	ipB := domB.AddDataPoint(pointB, tase2.ICCPTypeRealQTimeTag)
	ipB.UpdateValue(convertToICCPValue(tagB, tase2.ICCPTypeRealQTimeTag), nil)
	domB.AddDSTransferSet("DSTrans").AttachDataSet("SUB_B", "SUB_B_DataSet")

	datasetDefs := []datasetDef{
		{name: "SUB_A/SUB_A_DataSet", items: []tase2.ObjectRef{{Domain: "SUB_A", Item: pointA}}},
		{name: "SUB_B/SUB_B_DataSet", items: []tase2.ObjectRef{{Domain: "SUB_B", Item: pointB}}},
	}

	// Connection restricted to topic SUB_A: the BLT must hide SUB_B.
	conn := protocolConnection{
		Name:                     "LOOPBACK",
		ProtocolConnectionNumber: 9101,
		RemoteApTitle:            "1.1.999.2",
		RemoteAeQualifier:        12,
		Topics:                   []string{"SUB_A"},
	}
	cfg := tase2.ServerConfig{
		Port: port, LocalAPTitle: "1.1.999.1", LocalAEQual: 12,
		SupportedCBBs: []tase2.ConformanceBlock{
			tase2.CBB1_BasicPeriodicData, tase2.CBB2_ExtendedDataSets, tase2.CBB5_DeviceControl,
		},
		VendorName: "JSON-SCADA", ModelName: "ICCP-Server-Test", Revision: DriverVersion,
	}

	registry := newServerRegistry()

	srvEP := tase2.NewEndpoint(tase2.EndpointPassive)
	srvEP.SetLocalAPTitle("1.1.999.1", 12)
	if err := srvEP.Listen(port); err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer srvEP.Disconnect()

	// Serve exactly as main() does: ServeClients with registry bookkeeping in
	// the build callback and the post-disconnect hook.
	go srvEP.ServeClients(
		func(ce *tase2.Endpoint) *tase2.Server {
			srv := buildServer(dataModel, ce, cfg, conn, datasetDefs, nil)
			registry.add(srv, ce, conn)
			return srv
		},
		func(ce *tase2.Endpoint, srv *tase2.Server, serveErr error) {
			registry.remove(srv)
		},
	)

	// ---- Client (peer identity matching the BLT) ----
	cliEP := tase2.NewEndpoint(tase2.EndpointActive)
	cliEP.SetLocalAPTitle("1.1.999.2", 12)
	cliEP.SetRemoteAPTitle("1.1.999.1", 12)
	time.Sleep(50 * time.Millisecond)
	if err := cliEP.Connect("127.0.0.1", port); err != nil {
		t.Fatalf("connect: %v", err)
	}
	client := tase2.NewClient(cliEP)
	defer client.Close()

	// BLT topic isolation: only SUB_A may be discovered.
	domains, err := client.ListDomains()
	if err != nil {
		t.Fatalf("ListDomains: %v", err)
	}
	if len(domains) != 1 || domains[0] != "SUB_A" {
		t.Errorf("discovered domains = %v, want [SUB_A] only (BLT topic isolation)", domains)
	}

	// Granted domain reads and decodes correctly.
	v, err := client.ReadDataValue("SUB_A", pointA)
	if err != nil {
		t.Fatalf("ReadDataValue SUB_A/%s: %v", pointA, err)
	}
	dp := tase2.DecodeICCP(v)
	if dp.Real == nil || *dp.Real < 55.4 || *dp.Real > 55.6 {
		t.Errorf("SUB_A value = %v, want ~55.5", dp.Real)
	}
	if dp.Quality == nil || dp.Quality.Validity != "good" {
		t.Errorf("SUB_A quality = %+v, want good", dp.Quality)
	}

	// Non-granted domain must not be readable.
	if _, err := client.ReadDataValue("SUB_B", pointB); err == nil {
		t.Error("ReadDataValue SUB_B succeeded, want denial (BLT topic isolation)")
	}

	// ---- DSTS subscription + change-stream buffering path ----
	reportCh := make(chan tase2.Report, 8)
	client.OnDSTransferSetReport(func(report tase2.Report, finished bool) {
		if finished {
			reportCh <- report
		}
	})

	dstsCfg := tase2.DSTSConfig{
		DataSet:    tase2.ObjectRef{Domain: "SUB_A", Item: "SUB_A_DataSet"},
		BufferTime: 0,
		RBE:        true,
		Conditions: tase2.DSConditionChange,
	}
	if err := client.ConfigureDSTransferSet("SUB_A", "DSTrans", dstsCfg); err != nil {
		t.Fatalf("ConfigureDSTransferSet: %v", err)
	}
	if err := client.StartDSTransferSet("SUB_A", "DSTrans"); err != nil {
		t.Fatalf("StartDSTransferSet: %v", err)
	}

	servers := registry.snapshot()
	if len(servers) != 1 {
		t.Fatalf("registry has %d servers, want 1", len(servers))
	}

	// Buffer an update exactly as watchRealtimeDataChanges does, then flush.
	tagA.Value = 66.25
	newVal := convertToICCPValue(tagA, ipA.ICCPType)
	pendingChangesMu.Lock()
	for _, entry := range servers {
		srvMap := pendingChangesMap[entry.server]
		if srvMap == nil {
			srvMap = make(map[*tase2.IndicationPoint]pendingPointUpdate)
			pendingChangesMap[entry.server] = srvMap
		}
		srvMap[ipA] = pendingPointUpdate{ip: ipA, value: newVal, quality: nil}
	}
	pendingChangesMu.Unlock()
	flushPendingChanges()

	deadline := time.After(5 * time.Second)
	for {
		var report tase2.Report
		select {
		case report = <-reportCh:
		case <-deadline:
			t.Fatal("timed out waiting for DSTS change report after flushPendingChanges")
		}
		found := false
		for _, rv := range report.Values {
			if rv.Domain == "SUB_A" && rv.Item == pointA && rv.Value != nil {
				d := tase2.DecodeICCP(rv.Value)
				if d.Real != nil && *d.Real > 66.2 && *d.Real < 66.3 {
					found = true
				}
			}
		}
		if found {
			break
		}
	}

	// Disconnect and verify the post-disconnect hook drains the registry.
	client.Close()
	drained := false
	for i := 0; i < 50; i++ {
		if len(registry.snapshot()) == 0 {
			drained = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !drained {
		t.Errorf("registry still has %d server(s) after client disconnect; post-disconnect hook did not fire", len(registry.snapshot()))
	}
}
