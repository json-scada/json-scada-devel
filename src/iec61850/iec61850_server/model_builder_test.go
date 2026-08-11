package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/dscsystems/go-iec61850/mms"
	"github.com/dscsystems/go-iec61850/model"
)

func testConn() *ServerConnection {
	return &ServerConnection{
		ProtocolConnectionNumber: 8001,
		Name:                     "IEC61850SRV",
		Enabled:                  true,
		CommandsEnabled:          true,
		IPAddressLocalBind:       "0.0.0.0:10102",
		ServerModeMultiActive:    true,
		MaxClientConnections:     2,
		MaxQueueSize:             1000,
	}
}

func pt(id float64, tag, typ, origin, group1 string) *Point {
	return &Point{
		ID: id, Tag: tag, Type: typ, Origin: origin, Group1: group1,
		Description: "desc of " + tag, Invalid: true,
		Kconv1: 1, Kconv2: 0,
		SrcConnectionNumber: 91, SrcCommonAddress: "1",
		SrcObjectAddress: tag + "_addr", SrcASDU: "",
	}
}

func TestSanitizeMms(t *testing.T) {
	cases := []struct{ in, want string }{
		{"IEC61850SRV", "IEC61850SRV"},
		{"KAW2", "KAW2"},
		{"with space", "with_space"},
		{"1digit", "P1digit"},
		{"", "P"},
		{"___", "P"},
	}
	for _, c := range cases {
		if got := sanitizeMms(c.in, 20); got != c.want {
			t.Errorf("sanitizeMms(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// Over-long names are truncated with a stable hash suffix.
	long := strings.Repeat("A", 40)
	got := sanitizeMms(long, 20)
	if len(got) != 20 || !strings.Contains(got, "_") {
		t.Errorf("truncated name = %q (len %d)", got, len(got))
	}
	if got != sanitizeMms(long, 20) {
		t.Error("truncation must be stable")
	}
}

func TestUniqueName(t *testing.T) {
	used := map[string]bool{}
	if n := uniqueName("KAW2", used); n != "KAW2" {
		t.Errorf("first = %q", n)
	}
	if n := uniqueName("KAW2", used); n != "KAW2_2" {
		t.Errorf("second = %q", n)
	}
	if n := uniqueName("KAW2", used); n != "KAW2_3" {
		t.Errorf("third = %q", n)
	}
}

// One logical device per topic, LLN0 and LPHD1 always present, points in
// GGIO instances, object references built from the IED and LD names.
func TestBuildModelLayout(t *testing.T) {
	conn := testConn()
	points := []*Point{
		pt(1, "D1", "digital", "supervised", "KAW2"),
		pt(2, "A1", "analog", "supervised", "KAW2"),
		pt(3, "S1", "string", "supervised", "KAW2"),
		pt(4, "C1", "digital", "command", "KAW2"),
		pt(5, "C2", "analog", "command", "KAW2"),
		pt(6, "D2", "digital", "supervised", "KIK3"),
		pt(7, "D3", "digital", "supervised", ""), // no group1 -> GEN
	}
	built := BuildModel(points, conn)

	if built.Devices != 3 {
		t.Fatalf("logical devices = %d, want 3 (KAW2, KIK3, GEN)", built.Devices)
	}
	names := map[string]bool{}
	for _, ld := range built.Model.Devices {
		names[ld.Name] = true
		if ld.Node("LLN0") == nil {
			t.Errorf("%s has no LLN0", ld.Name)
		}
		if ld.Node("LPHD1") == nil {
			t.Errorf("%s has no LPHD1", ld.Name)
		}
	}
	for _, want := range []string{"IEC61850SRVKAW2", "IEC61850SRVKIK3", "IEC61850SRVGEN"} {
		if !names[want] {
			t.Errorf("missing logical device %s (have %v)", want, names)
		}
	}

	// Object references and classes.
	expect := map[string]struct {
		ref  string
		kind PointKind
	}{
		"D1": {"IEC61850SRVKAW2/GGIO1.Ind1", KindSPS},
		"A1": {"IEC61850SRVKAW2/GGIO1.AnIn1", KindMV},
		"S1": {"IEC61850SRVKAW2/GGIO1.Str1", KindVSS},
		"C1": {"IEC61850SRVKAW2/GGIO1.SPCSO1", KindSPC},
		"C2": {"IEC61850SRVKAW2/GGIO1.AnOut1", KindAPC},
		"D2": {"IEC61850SRVKIK3/GGIO1.Ind1", KindSPS},
		"D3": {"IEC61850SRVGEN/GGIO1.Ind1", KindSPS},
	}
	for tag, want := range expect {
		mp := built.ByTag[tag]
		if mp == nil {
			t.Errorf("tag %s not mapped", tag)
			continue
		}
		if string(mp.ObjRef) != want.ref {
			t.Errorf("%s objRef = %s, want %s", tag, mp.ObjRef, want.ref)
		}
		if mp.Kind != want.kind {
			t.Errorf("%s kind = %v, want %v", tag, mp.Kind, want.kind)
		}
	}

	// Commands are addressable by object reference and are not in a data set.
	if len(built.ByCtlObjRef) != 2 {
		t.Errorf("command points = %d, want 2", len(built.ByCtlObjRef))
	}

	// The proxy flag marks the gateway, and descriptions are published.
	for _, ld := range built.Model.Devices {
		proxy := ld.Node("LPHD1").Object("Proxy")
		if v := proxy.Attribute("stVal"); v == nil || v.Value == nil || !v.Value.Bool() {
			t.Errorf("%s LPHD1.Proxy.stVal is not true", ld.Name)
		}
	}
	if d := built.Model.Attribute("IEC61850SRVKAW2/GGIO1.Ind1.d", model.DC); d == nil || d.Value.Text() != "desc of D1" {
		t.Errorf("description attribute wrong: %v", d)
	}
}

// Every point's value, quality and timestamp must resolve in the model:
// that is what the update path writes to.
func TestBuildModelValueRefsResolve(t *testing.T) {
	conn := testConn()
	points := []*Point{
		pt(1, "D1", "digital", "supervised", "T"),
		pt(2, "A1", "analog", "supervised", "T"),
		pt(3, "S1", "string", "supervised", "T"),
		pt(4, "C1", "digital", "command", "T"),
		pt(5, "C2", "analog", "command", "T"),
	}
	built := BuildModel(points, conn)

	wantKind := map[string]mms.Type{
		"D1": mms.TypeBoolean,
		"A1": mms.TypeFloat32,
		"S1": mms.TypeVisibleString,
		"C1": mms.TypeBoolean,
		"C2": mms.TypeFloat32,
	}
	for tag, mp := range built.ByTag {
		v := built.Model.Attribute(mp.ValueRef, mp.FC)
		if v == nil {
			t.Errorf("%s: value attribute %s [%s] does not resolve", tag, mp.ValueRef, mp.FC)
			continue
		}
		if v.Kind != wantKind[tag] {
			t.Errorf("%s: value kind = %v, want %v", tag, v.Kind, wantKind[tag])
		}
		if q := built.Model.Attribute(mp.QRef, mp.FC); q == nil {
			t.Errorf("%s: quality attribute does not resolve", tag)
		}
		if ts := built.Model.Attribute(mp.TRef, mp.FC); ts == nil {
			t.Errorf("%s: timestamp attribute does not resolve", tag)
		}
	}
}

// Data sets carry one DO-level FCDA per monitored point, split by family,
// and no command points.
func TestDataSetsAreDataObjectLevel(t *testing.T) {
	conn := testConn()
	points := []*Point{
		pt(1, "D1", "digital", "supervised", "T"),
		pt(2, "A1", "analog", "supervised", "T"),
		pt(3, "S1", "string", "supervised", "T"),
		pt(4, "C1", "digital", "command", "T"),
	}
	built := BuildModel(points, conn)
	lln0 := built.Model.Devices[0].Node("LLN0")

	var st, mx *model.DataSet
	for _, ds := range lln0.DataSets {
		switch ds.Name {
		case "DS_ST_1":
			st = ds
		case "DS_MX_1":
			mx = ds
		}
	}
	if st == nil || mx == nil {
		t.Fatalf("data sets missing: %v", lln0.DataSets)
	}
	if len(st.Entries) != 2 { // D1 and S1
		t.Errorf("status data set entries = %d, want 2", len(st.Entries))
	}
	if len(mx.Entries) != 1 { // A1
		t.Errorf("measurand data set entries = %d, want 1", len(mx.Entries))
	}
	for _, e := range st.Entries {
		if strings.Contains(string(e.Ref), ".stVal") || strings.Contains(string(e.Ref), ".q") {
			t.Errorf("entry %s is attribute-level, want the data object", e.Ref)
		}
		if e.FC != model.ST {
			t.Errorf("entry %s FC = %v, want ST", e.Ref, e.FC)
		}
		if strings.Contains(string(e.Ref), "SPCSO") {
			t.Errorf("command point %s must not be a data set member", e.Ref)
		}
	}
	if mx.Entries[0].FC != model.MX {
		t.Errorf("measurand entry FC = %v, want MX", mx.Entries[0].FC)
	}
}

// One buffered and one unbuffered control block per data set, named so the
// server materialises the same instance names the C# driver created.
func TestReportControls(t *testing.T) {
	conn := testConn() // maxClientConnections 2 -> 2 RCB copies
	points := []*Point{
		pt(1, "D1", "digital", "supervised", "T"),
		pt(2, "A1", "analog", "supervised", "T"),
	}
	built := BuildModel(points, conn)
	lln0 := built.Model.Devices[0].Node("LLN0")

	if len(lln0.ReportControls) != 4 { // brcbST01, urcbST01, brcbMX01, urcbMX01
		t.Fatalf("report controls = %d, want 4", len(lln0.ReportControls))
	}
	byName := map[string]*model.ReportControl{}
	for _, rc := range lln0.ReportControls {
		byName[rc.Name] = rc
	}
	for _, name := range []string{"brcbST01", "urcbST01", "brcbMX01", "urcbMX01"} {
		rc := byName[name]
		if rc == nil {
			t.Fatalf("missing report control %s", name)
		}
		if rc.RptEnabled != 2 {
			t.Errorf("%s RptEnabled = %d, want 2", name, rc.RptEnabled)
		}
		if rc.ConfRev == 0 {
			t.Errorf("%s has no confRev", name)
		}
		if rc.TrgOps&model.TrgDataChange == 0 || rc.TrgOps&model.TrgGI == 0 {
			t.Errorf("%s trigger options = %v", name, rc.TrgOps)
		}
		wantDS := "DS_ST_1"
		if strings.Contains(name, "MX") {
			wantDS = "DS_MX_1"
		}
		if rc.DataSet != wantDS {
			t.Errorf("%s data set = %q, want %q", name, rc.DataSet, wantDS)
		}
	}
	if byName["brcbST01"].MaxQueueSize != 1000 {
		t.Errorf("buffered depth = %d, want 1000", byName["brcbST01"].MaxQueueSize)
	}
	if !byName["brcbST01"].Buffered || byName["urcbST01"].Buffered {
		t.Error("buffered flags wrong")
	}
}

// A logical node holds at most MaxDataObjectsPerLN cost units, string
// points cost 8, and each instance numbers its objects from 1.
func TestGgioPacking(t *testing.T) {
	conn := testConn()
	var points []*Point
	for i := 1; i <= MaxDataObjectsPerLN+5; i++ {
		points = append(points, pt(float64(i), fmt.Sprintf("D%d", i), "digital", "supervised", "T"))
	}
	built := BuildModel(points, conn)

	if got := string(built.ByTag["D1"].ObjRef); got != "IEC61850SRVT/GGIO1.Ind1" {
		t.Errorf("first point = %s", got)
	}
	if got := string(built.ByTag[fmt.Sprintf("D%d", MaxDataObjectsPerLN)].ObjRef); got !=
		fmt.Sprintf("IEC61850SRVT/GGIO1.Ind%d", MaxDataObjectsPerLN) {
		t.Errorf("last point of GGIO1 = %s", got)
	}
	// The next point opens GGIO2 and renumbers from 1.
	if got := string(built.ByTag[fmt.Sprintf("D%d", MaxDataObjectsPerLN+1)].ObjRef); got != "IEC61850SRVT/GGIO2.Ind1" {
		t.Errorf("first point of GGIO2 = %s", got)
	}

	// A string point costs 8 units.
	conn2 := testConn()
	var pts2 []*Point
	for i := 1; i <= 4; i++ {
		pts2 = append(pts2, pt(float64(i), fmt.Sprintf("S%d", i), "string", "supervised", "T"))
	}
	b2 := BuildModel(pts2, conn2)
	// Three string points fill 24 of the 30 units; the fourth would make 32
	// and therefore opens a new instance.
	if got := string(b2.ByTag["S3"].ObjRef); got != "IEC61850SRVT/GGIO1.Str3" {
		t.Errorf("3rd string point = %s, want GGIO1.Str3", got)
	}
	if got := string(b2.ByTag["S4"].ObjRef); got != "IEC61850SRVT/GGIO2.Str1" {
		t.Errorf("4th string point = %s, want GGIO2.Str1", got)
	}
}

// Topics larger than the derived limit are split across logical devices.
func TestOversizedTopicSplit(t *testing.T) {
	conn := testConn()
	bounds := computeModelBounds(conn)
	var points []*Point
	for i := 1; i <= bounds.maxPointsPerLD+1; i++ {
		points = append(points, pt(float64(i), fmt.Sprintf("D%d", i), "digital", "supervised", "BULK"))
	}
	built := BuildModel(points, conn)
	if built.Devices != 2 {
		t.Fatalf("devices = %d, want 2", built.Devices)
	}
	if built.Model.Devices[1].Inst != "BULK_2" {
		t.Errorf("second device inst = %q, want BULK_2", built.Model.Devices[1].Inst)
	}
}

// Data sets never exceed the entry bound.
func TestDataSetChunking(t *testing.T) {
	conn := testConn()
	var points []*Point
	for i := 1; i <= EntriesPerDataSet+5; i++ {
		points = append(points, pt(float64(i), fmt.Sprintf("D%d", i), "digital", "supervised", "T"))
	}
	built := BuildModel(points, conn)
	lln0 := built.Model.Devices[0].Node("LLN0")
	total := 0
	for _, ds := range lln0.DataSets {
		if len(ds.Entries) > EntriesPerDataSet {
			t.Errorf("data set %s has %d entries, over the bound", ds.Name, len(ds.Entries))
		}
		total += len(ds.Entries)
	}
	if total != EntriesPerDataSet+5 {
		t.Errorf("total entries = %d, want %d", total, EntriesPerDataSet+5)
	}
}

// The control model follows protocolSourceCommandUseSBO.
func TestControlModelFromUseSBO(t *testing.T) {
	conn := testConn()
	direct := pt(1, "CD", "digital", "command", "T")
	sbo := pt(2, "CS", "digital", "command", "T")
	sbo.SrcCommandUseSBO = true
	built := BuildModel([]*Point{direct, sbo}, conn)

	check := func(tag string, want model.CtlModel, wantSBO bool) {
		mp := built.ByTag[tag]
		cm := built.Model.Attribute(mp.ObjRef.Child("ctlModel"), model.CF)
		if cm == nil || model.CtlModel(cm.Value.Int64()) != want {
			t.Errorf("%s ctlModel = %v, want %v", tag, cm, want)
		}
		sboAttr := built.Model.Attribute(mp.ObjRef.Child("SBO"), model.CO)
		if wantSBO != (sboAttr != nil) {
			t.Errorf("%s SBO attribute present = %v, want %v", tag, sboAttr != nil, wantSBO)
		}
		if oper := built.Model.Attribute(mp.ObjRef.Child("Oper"), model.CO); oper == nil {
			t.Errorf("%s has no Oper", tag)
		} else if len(oper.Children) != 6 {
			t.Errorf("%s Oper has %d members, want 6", tag, len(oper.Children))
		}
	}
	check("CD", model.CtlDirectNormal, false)
	check("CS", model.CtlSBONormal, true)
}

// Descriptions are truncated so response sizes never depend on how long an
// operator made a tag description.
func TestDescriptionTruncation(t *testing.T) {
	conn := testConn()
	p := pt(1, "D1", "digital", "supervised", "T")
	p.Description = strings.Repeat("x", MaxDescriptionLength+40)
	built := BuildModel([]*Point{p}, conn)
	d := built.Model.Attribute(built.ByTag["D1"].ObjRef.Child("d"), model.DC)
	if d == nil || len(d.Value.Text()) != MaxDescriptionLength {
		t.Errorf("description length = %d, want %d", len(d.Value.Text()), MaxDescriptionLength)
	}
}

func TestParseBindAddress(t *testing.T) {
	cases := []struct {
		bind     string
		security bool
		want     string
	}{
		{"0.0.0.0:102", false, "0.0.0.0:102"},
		{"", false, "0.0.0.0:102"},
		{"", true, "0.0.0.0:3782"},
		{"127.0.0.1:10102", false, "127.0.0.1:10102"},
		{"192.168.0.5", false, "192.168.0.5:102"},
	}
	for _, c := range cases {
		conn := &ServerConnection{IPAddressLocalBind: c.bind, UseSecurity: c.security}
		if got := parseBindAddress(conn); got != c.want {
			t.Errorf("parseBindAddress(%q, security=%v) = %q, want %q", c.bind, c.security, got, c.want)
		}
	}
}
