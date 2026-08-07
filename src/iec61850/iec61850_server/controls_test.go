package main

import (
	"errors"
	"testing"
	"time"

	"github.com/dscsystems/go-iec61850/client"
	"github.com/dscsystems/go-iec61850/mms"
	"github.com/dscsystems/go-iec61850/model"
	"github.com/dscsystems/go-iec61850/server"
)

// helpers shared with the loopback test.

func mmsBool(b bool) *mms.Value { return mms.NewBool(b) }

// mmsAnalogue builds the AnalogueValue an APC control carries.
func mmsAnalogue(f float64) *mms.Value {
	return mms.NewStructure(mms.NewFloat32(float32(f)))
}

func asControlError(err error, target **client.ControlError) bool {
	return errors.As(err, target)
}

func waitCommand(t *testing.T, d time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if doc, ok := dequeueCommand(); ok {
			return doc
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out waiting for a queued command")
	return nil
}

// controlValue converts a ctlVal the way each class expects, which is what
// decides the value pair of the commandsQueue document.
func TestControlValueConversion(t *testing.T) {
	cases := []struct {
		name       string
		kind       PointKind
		in         *mms.Value
		wantValue  float64
		wantString string
		wantOK     bool
	}{
		{"spc true", KindSPC, mms.NewBool(true), 1, "true", true},
		{"spc false", KindSPC, mms.NewBool(false), 0, "false", true},
		{"spc wrong type", KindSPC, mms.NewFloat32(1), 0, "", false},
		{"apc float", KindAPC, mms.NewStructure(mms.NewFloat32(37.5)), 37.5, "37.5", true},
		{"apc integer", KindAPC, mms.NewStructure(mms.NewInt32(42)), 42, "42", true},
		{"apc bare float", KindAPC, mms.NewFloat32(1.5), 1.5, "1.5", true},
		{"inc", KindINC, mms.NewInt32(7), 7, "7", true},
		{"nil", KindSPC, nil, 0, "", false},
	}
	for _, c := range cases {
		v, s, ok := controlValue(c.kind, c.in)
		if ok != c.wantOK {
			t.Errorf("%s: ok = %v, want %v", c.name, ok, c.wantOK)
			continue
		}
		if !ok {
			continue
		}
		if v != c.wantValue || s != c.wantString {
			t.Errorf("%s: (%v,%q), want (%v,%q)", c.name, v, s, c.wantValue, c.wantString)
		}
	}
}

// The queued document must carry every field the C# driver writes, with the
// routing fields keeping the BSON type of the source tag.
func TestCommandDocumentShape(t *testing.T) {
	conn := testConn()
	p := pt(4, "CMD1", "digital", "command", "T")
	p.SrcCommonAddress = "3"           // string, as an IEC 104 tag would have
	p.SrcObjectAddress = float64(1234) // double, as an OPC tag might have
	p.SrcCommandDuration = 2
	built := BuildModel([]*Point{p}, conn)

	g := &Gateway{conn: conn, built: built}
	active.Store(true)
	defer active.Store(false)
	drainCommands()

	mp := built.ByTag["CMD1"]
	cause := g.handleControl(mp, &server.ControlCtx{
		Ref:   mp.ObjRef,
		Value: mms.NewBool(true),
		Peer:  "10.1.2.3:45678",
	})
	if cause != model.AddCauseNone {
		t.Fatalf("control refused: %v", cause)
	}

	doc, ok := dequeueCommand()
	if !ok {
		t.Fatal("no command queued")
	}
	for _, f := range []string{
		"protocolSourceConnectionNumber", "protocolSourceCommonAddress",
		"protocolSourceObjectAddress", "protocolSourceASDU",
		"protocolSourceCommandDuration", "protocolSourceCommandUseSBO",
		"pointKey", "tag", "value", "valueString",
		"originatorUserName", "originatorIpAddress", "timeTag",
	} {
		if _, present := doc[f]; !present {
			t.Errorf("missing field %q", f)
		}
	}

	// Routing fields keep the type the source tag had.
	if s, isStr := doc["protocolSourceCommonAddress"].(string); !isStr || s != "3" {
		t.Errorf("common address = %#v, want the string \"3\"", doc["protocolSourceCommonAddress"])
	}
	if f, isNum := doc["protocolSourceObjectAddress"].(float64); !isNum || f != 1234 {
		t.Errorf("object address = %#v, want the double 1234", doc["protocolSourceObjectAddress"])
	}
	if doc["protocolSourceCommandDuration"] != float64(2) {
		t.Errorf("command duration = %#v", doc["protocolSourceCommandDuration"])
	}
	if doc["tag"] != "CMD1" || doc["value"] != float64(1) || doc["valueString"] != "true" {
		t.Errorf("value fields = %v / %v / %v", doc["tag"], doc["value"], doc["valueString"])
	}
	if doc["originatorUserName"] != "IEC61850 connection: 8001 IEC61850SRV" {
		t.Errorf("originatorUserName = %v", doc["originatorUserName"])
	}
	if doc["originatorIpAddress"] != "10.1.2.3:45678" {
		t.Errorf("originatorIpAddress = %v", doc["originatorIpAddress"])
	}

	// The select phase accepts but queues nothing.
	cause = g.handleControl(mp, &server.ControlCtx{Ref: mp.ObjRef, Value: mms.NewBool(true), Select: true})
	if cause != model.AddCauseNone {
		t.Errorf("select refused: %v", cause)
	}
	if _, queued := dequeueCommand(); queued {
		t.Error("the select phase must not queue a command")
	}

	// While inactive, controls are blocked.
	active.Store(false)
	if cause := g.handleControl(mp, &server.ControlCtx{Ref: mp.ObjRef, Value: mms.NewBool(true)}); cause != model.AddCauseBlockedByMode {
		t.Errorf("inactive control cause = %v, want blocked-by-mode", cause)
	}
	if _, queued := dequeueCommand(); queued {
		t.Error("a blocked control must not queue a command")
	}
}
