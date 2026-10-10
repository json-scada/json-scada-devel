/*
 * OPC-UA Client Protocol driver for {json:scada}, in Go.
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 */

package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/gopcua/opcua/server"
	"github.com/gopcua/opcua/ua"
)

func TestIsEphemeralDiagnostic(t *testing.T) {
	cases := []struct {
		addr, path string
		want       bool
	}{
		{"ns=0;i=3707", "", true},
		{"ns=0;i=2290", "", true},
		{"ns=0;i=3708", "", true},
		{"ns=0;i=3706", "", true},
		{"ns=1;i=3707", "", false},
		{"ns=0;i=2259", "/Objects/Server/ServerStatus/State", false},
		{"ns=0;s=x", "/Objects/Server/ServerDiagnostics/SessionsDiagnosticsSummary/Sess1/Count", true},
		{"ns=0;s=x", "Server/ServerDiagnostics/SubscriptionDiagnosticsArray/3", true},
		{"ns=0;i=2294", "/Objects/Server/ServerDiagnostics/ServerDiagnosticsSummary/ServerViewCount", false},
		{"not a node id", "/Objects/Boiler", false},
	}
	for _, c := range cases {
		if got := isEphemeralDiagnostic(c.addr, c.path); got != c.want {
			t.Errorf("isEphemeralDiagnostic(%q, %q) = %v, want %v", c.addr, c.path, got, c.want)
		}
	}
}

// The browse neither records nor expands a per-session diagnostics subtree.
func TestBrowseSkipsEphemeralDiagnostics(t *testing.T) {
	cli, objects, ns := startTestServer(t)

	diag := server.NewFolderNode(ua.NewStringNodeID(1, "SessionsDiagnosticsSummary"), "SessionsDiagnosticsSummary")
	ns.AddNode(diag)
	ns.Objects().AddRef(diag, server.RefTypeIDOrganizes, true)
	leaf := server.NewVariableNode(ua.NewStringNodeID(1, "Sess.Count"), "Count", int32(3))
	ns.AddNode(leaf)
	diag.AddRef(leaf, server.RefTypeIDOrganizes, true)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	browsed, err := browseFullAddressSpace(ctx, cli, testConn(), objects)
	if err != nil {
		t.Fatalf("browse: %v", err)
	}
	if _, ok := browsed.Refs["ns=1;s=Boiler.Temp"]; !ok {
		t.Error("an ordinary node went missing")
	}
	for key, e := range browsed.Refs {
		if strings.Contains(e.Path, "SessionsDiagnosticsSummary") {
			t.Errorf("diagnostics node %s (%s) must be skipped", key, e.Path)
		}
	}
}

// A single item that floods is cut off at the cap and nothing else is.
func TestItemFloodProtection(t *testing.T) {
	it := &monItem{NodeID: "ns=1;s=A"}
	other := &monItem{NodeID: "ns=1;s=B"}
	now := time.Now()

	accepted, firsts := 0, 0
	for i := 0; i < maxItemEventsPerSecond*3; i++ {
		ok, first := it.allow(now)
		if ok {
			accepted++
		}
		if first {
			firsts++
		}
		if o, _ := other.allow(now); i < maxItemEventsPerSecond && !o {
			t.Fatal("a quiet item was throttled")
		}
	}
	if accepted != maxItemEventsPerSecond || firsts != 1 {
		t.Errorf("accepted %d (want %d), first-refusal flags %d (want 1)", accepted, maxItemEventsPerSecond, firsts)
	}
	if ok, _ := it.allow(now.Add(1100 * time.Millisecond)); !ok {
		t.Error("the item must be accepted again in the next window")
	}
}

func TestHandleNotificationDropsFlood(t *testing.T) {
	conn := testConn()
	it := &monItem{NodeID: "ns=1;s=A", DisplayName: "A"}
	conn.NewHandle(it)
	drainQueue()

	before := CntFloodDropped.Load()
	n := maxItemEventsPerSecond + 50
	for i := 0; i < n; i++ {
		handleNotification(conn, &ua.MonitoredItemNotification{
			ClientHandle: it.Handle,
			Value:        &ua.DataValue{EncodingMask: ua.DataValueValue, Value: ua.MustVariant(float64(i))},
		})
	}
	queued := 0
	for {
		if _, ok := dequeueValue(); !ok {
			break
		}
		queued++
	}
	if queued != maxItemEventsPerSecond {
		t.Errorf("queued %d values, want %d", queued, maxItemEventsPerSecond)
	}
	if got := CntFloodDropped.Load() - before; got != 50 || it.Flooded.Load() != 50 {
		t.Errorf("dropped %d (item %d), want 50", got, it.Flooded.Load())
	}
}
