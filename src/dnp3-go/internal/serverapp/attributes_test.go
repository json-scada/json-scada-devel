package serverapp

import (
	"context"
	"testing"
	"time"

	dnp3 "github.com/dscsystems/go-dnp3"
	"github.com/dscsystems/go-dnp3/channel"
	"github.com/dscsystems/go-dnp3/master"
	"github.com/dscsystems/go-dnp3/outstation"
)

// indexAttributes keys a set of attributes by variation, failing on anything
// outside set 0 or reported twice.
func indexAttributes(t *testing.T, attrs []dnp3.Attribute) map[uint8]dnp3.Attribute {
	t.Helper()
	out := map[uint8]dnp3.Attribute{}
	for _, a := range attrs {
		if a.Set != dnp3.AttrSetStandard {
			t.Errorf("attribute %d is in set %d, want the standard set", a.Variation, a.Set)
		}
		if _, dup := out[a.Variation]; dup {
			t.Errorf("attribute %d reported twice", a.Variation)
		}
		out[a.Variation] = a
	}
	return out
}

// TestDeviceAttributes checks the identity a connection reports.
func TestDeviceAttributes(t *testing.T) {
	conn := &Connection{
		ProtocolConnectionNumber: 34,
		Name:                     "DNP3SRV",
		Description:              "KAW2 substation gateway",
	}
	byVariation := indexAttributes(t, deviceAttributes(conn, outstation.DatabaseConfig{}))

	want := map[uint8]string{
		attrManufacturer:    manufacturerName,
		attrProductName:     productName,
		attrSoftwareVersion: DriverVersion,
		attrDeviceName:      "DNP3SRV",
		attrLocation:        "KAW2 substation gateway",
		attrIDCode:          "34",
		attrSystemName:      systemName,
	}
	for variation, value := range want {
		a, ok := byVariation[variation]
		if !ok {
			t.Errorf("attribute %d not reported", variation)
			continue
		}
		if a.Value() != value {
			t.Errorf("attribute %d = %q, want %q", variation, a.Value(), value)
		}
	}

	if a, ok := byVariation[attrHardwareVersion]; !ok || a.Value() == "" {
		t.Error("the host platform should be reported as the hardware version")
	}

	// Two attributes are deliberately not answered: a conformance level nobody
	// has certified, and a serial number a gateway does not have. A plausible
	// wrong value propagates further than a missing one.
	for _, variation := range []uint8{248, 249} {
		if a, reported := byVariation[variation]; reported {
			t.Errorf("attribute %d must not be reported, got %q", variation, a.Value())
		}
	}
}

// TestDeviceAttributesOptionalFields checks that a connection with no
// description does not report an empty location: saying nothing and saying
// "" are different answers. The one empty value is the list of private
// attribute sets, where empty is the answer: there are none.
func TestDeviceAttributesOptionalFields(t *testing.T) {
	conn := &Connection{ProtocolConnectionNumber: 1, Name: "SRV"}
	for _, a := range deviceAttributes(conn, outstation.DatabaseConfig{}) {
		if a.Variation == attrLocation {
			t.Errorf("location reported as %q for a connection with no description", a.Value())
		}
		if a.Value() == "" && a.Variation != attrUserSpecificSets {
			t.Errorf("attribute %d reported with an empty value", a.Variation)
		}
	}
}

// TestDeviceAttributeBlocks checks the per point type block of set 0 against
// the database it describes, under the numbers IEEE 1815 gives them.
func TestDeviceAttributeBlocks(t *testing.T) {
	db := outstation.DatabaseConfig{
		Binary: 3, DoubleBitBinary: 0, Analog: 5, Counter: 2, FrozenCounter: 2,
		BinaryOutputStatus: 4, AnalogOutputStatus: 1,
	}
	got := indexAttributes(t, deviceAttributes(&Connection{Name: "S"}, db))

	want := map[uint8]string{
		// events supported, max index, count
		237: "1", 238: "2", 239: "3", // binary inputs
		234: "0", 235: "0", 236: "0", // double-bit inputs: none
		231: "1", 232: "4", 233: "5", // analog inputs
		227: "1", 228: "1", 229: "2", // counters
		222: "1", 223: "3", 224: "4", // binary outputs
		219: "1", 220: "0", 221: "1", // analog outputs
		225: "1", 226: "1", // frozen counter events, frozen counters
		230: "0", // frozen analog inputs
		240: "2048", 241: "2048",
		216: "157",
	}
	for variation, value := range want {
		a, ok := got[variation]
		if !ok {
			t.Errorf("attribute %d not reported", variation)
			continue
		}
		if a.Value() != value {
			t.Errorf("attribute %d = %q, want %q", variation, a.Value(), value)
		}
	}

	// The "support for" attributes are signed integers, the counts, indexes
	// and sizes unsigned.
	for _, v := range []uint8{219, 222, 225, 226, 227, 230, 231, 234, 237} {
		if got[v].Type != dnp3.AttrSignedInt {
			t.Errorf("attribute %d has type %d, want signed integer", v, got[v].Type)
		}
	}
	for _, v := range []uint8{216, 220, 221, 223, 224, 228, 229, 232, 233, 235, 236, 238, 239, 240, 241} {
		if got[v].Type != dnp3.AttrUnsignedInt {
			t.Errorf("attribute %d has type %d, want unsigned integer", v, got[v].Type)
		}
	}
}

// TestAttributesCoverDerived checks that every key go-dnp3 derives is one this
// driver answers too, whatever the database holds. Configured attributes only
// replace derived ones they share a key with, so a key missed here would put
// the library's value beside this driver's in one response. go-dnp3 before
// v0.5.2 derived under numbers that meant something else in IEEE 1815, which
// is what a gap here would expose on a future renumbering.
func TestAttributesCoverDerived(t *testing.T) {
	derived := []uint8{
		outstation.AttrBinaryOutputCount, outstation.AttrCounterCount,
		outstation.AttrAnalogInputCount, outstation.AttrDoubleBitInputCount,
		outstation.AttrBinaryInputCount, outstation.AttrMaxTxFragment,
		outstation.AttrMaxRxFragment, outstation.AttrAnalogOutputCount,
	}
	for _, db := range []outstation.DatabaseConfig{
		{},
		{Binary: 1, DoubleBitBinary: 1, Analog: 1, Counter: 1, FrozenCounter: 1,
			BinaryOutputStatus: 1, AnalogOutputStatus: 1},
	} {
		got := indexAttributes(t, deviceAttributes(&Connection{Name: "S"}, db))
		for _, v := range derived {
			if _, ok := got[v]; !ok {
				t.Errorf("database %+v: variation %d is derived by go-dnp3 and not answered here", db, v)
			}
		}
	}
}

// TestDeviceAttributesOverTheWire reads the attributes back through a real
// master, which is the only way to know the outstation actually serves them,
// under the numbers IEEE 1815 gives them.
func TestDeviceAttributesOverTheWire(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Connection number 1, because the tag fixtures are written for it: the
	// destinations have to match or the database sizes to nothing.
	conn := &Connection{
		ProtocolConnectionNumber: 1,
		Name:                     "DNP3SRV",
		Description:              "KAW2 substation gateway",
		LocalLinkAddress:         10,
		RemoteLinkAddress:        1,
		ServerQueueSize:          100,
	}
	// Three binaries and one analog, so the counts have something to be wrong
	// about.
	tags := []map[string]any{
		tag(1, "B0", true, 1, 0, 2, nil),
		tag(2, "B1", true, 1, 1, 2, nil),
		tag(3, "B2", true, 1, 2, 2, nil),
		tag(4, "A0", 1.5, 30, 0, 5, nil),
	}

	e := &Engine{byNum: map[int]*Connection{1: conn}}
	station := e.newOutstation(conn, toBsonSlice(tags))
	conn.setStation(station)

	mch, och := channel.Pipe()
	go func() { _ = station.Run(ctx, och) }()

	m := master.New(master.Config{
		LocalAddr: 1, RemoteAddr: 10,
		ResponseTimeout: 5 * time.Second,
	}, master.NopHandler{})
	go func() { _ = m.Run(ctx, mch) }()

	waitFor(t, "the master to connect", m.Connected)

	readCtx, readCancel := context.WithTimeout(ctx, 10*time.Second)
	defer readCancel()
	attrs, err := m.ReadAttributes(readCtx)
	if err != nil {
		t.Fatalf("ReadAttributes: %v", err)
	}
	if len(attrs) == 0 {
		t.Fatal("the outstation reported no device attributes")
	}

	got := map[uint8]string{}
	for _, a := range attrs {
		if _, dup := got[a.Variation]; dup {
			t.Errorf("attribute %d came back twice", a.Variation)
		}
		got[a.Variation] = a.Value()
		t.Logf("  %3d %s", a.Variation, a.Value())
	}

	for variation, want := range map[uint8]string{
		attrManufacturer:    manufacturerName,
		attrProductName:     productName,
		attrSoftwareVersion: DriverVersion,
		attrDeviceName:      "DNP3SRV",
		attrLocation:        "KAW2 substation gateway",
		attrIDCode:          "1",
		// Three binary inputs, highest index 2; one analog input.
		239: "3", 238: "2", 237: "1",
		233: "1", 232: "0", 231: "1",
		// Numbers go-dnp3 before v0.5.2 used for counts and fragment sizes,
		// which mean frozen counters, counter events, max counter index and
		// max analog output index here.
		226: "0", 227: "0", 228: "0", 220: "0",
		240: "2048", 241: "2048",
	} {
		if got[variation] != want {
			t.Errorf("attribute %d over the wire = %q, want %q", variation, got[variation], want)
		}
	}
}

// TestCommandPassesCarryOutputStatus pins the readback mapping the auto-create
// pass applies: a CROB command is mirrored by a binary output status and an
// analog output block by an analog output status, at the same object address.
//
// The address is not a choice. DNP3 ties them together — a CROB at index N
// operates binary output N, whose state is group 10 index N — so a pass that
// assigned the status its own address would describe a different point.
func TestCommandPassesCarryOutputStatus(t *testing.T) {
	conn := &Connection{CommandsEnabled: true}
	passes := autoCreatePasses(conn)

	byGroup := map[int]autoCreatePass{}
	for _, p := range passes {
		byGroup[p.group] = p
	}

	crob, ok := byGroup[12]
	if !ok {
		t.Fatal("no CROB pass")
	}
	if crob.statusGroup != 10 {
		t.Errorf("CROB status group = %d, want 10 (binary output status)", crob.statusGroup)
	}
	if crob.statusASDU != 2 {
		t.Errorf("CROB status ASDU = %v, want 2 (g10v2)", crob.statusASDU)
	}

	analog, ok := byGroup[41]
	if !ok {
		t.Fatal("no analog output pass")
	}
	if analog.statusGroup != 40 {
		t.Errorf("analog command status group = %d, want 40 (analog output status)", analog.statusGroup)
	}
	if analog.statusASDU != 3 {
		t.Errorf("analog command status ASDU = %v, want 3 (g40v3)", analog.statusASDU)
	}

	// A supervised pass has no status companion: it is not a command, and
	// giving it one would publish the same point twice.
	for _, group := range []int{1, 30} {
		if p, ok := byGroup[group]; ok && p.statusGroup != 0 {
			t.Errorf("supervised pass for group %d must have no status group, got %d",
				group, p.statusGroup)
		}
	}

	// With commands disabled there are no command passes at all, so no status
	// destinations either.
	for _, p := range autoCreatePasses(&Connection{CommandsEnabled: false}) {
		if p.origin == "command" {
			t.Errorf("group %d command pass present with commands disabled", p.group)
		}
	}
}

// TestAttributeListOverTheWire reads g0v255, the list of attributes the
// outstation implements, and checks it names exactly what a read of every
// attribute returns, none of them writable.
func TestAttributeListOverTheWire(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	conn := &Connection{
		ProtocolConnectionNumber: 1, Name: "DNP3SRV",
		LocalLinkAddress: 10, RemoteLinkAddress: 1, ServerQueueSize: 100,
	}
	tags := []map[string]any{tag(1, "B0", true, 1, 0, 2, nil)}

	e := &Engine{byNum: map[int]*Connection{1: conn}}
	station := e.newOutstation(conn, toBsonSlice(tags))
	conn.setStation(station)

	mch, och := channel.Pipe()
	go func() { _ = station.Run(ctx, och) }()
	m := master.New(master.Config{
		LocalAddr: 1, RemoteAddr: 10, ResponseTimeout: 5 * time.Second,
	}, master.NopHandler{})
	go func() { _ = m.Run(ctx, mch) }()
	waitFor(t, "the master to connect", m.Connected)

	readCtx, readCancel := context.WithTimeout(ctx, 10*time.Second)
	defer readCancel()
	list, err := m.ReadAttribute(readCtx, dnp3.AttrSetStandard, dnp3.AttrList)
	if err != nil {
		t.Fatalf("ReadAttribute(g0v255): %v", err)
	}
	all, err := m.ReadAttributes(readCtx)
	if err != nil {
		t.Fatalf("ReadAttributes: %v", err)
	}

	if list.Type != dnp3.AttrAttributeList {
		t.Errorf("g0v255 has type %v, want an attribute list", list.Type)
	}
	listed := map[uint8]bool{}
	for _, it := range list.List() {
		if it.Writable {
			t.Errorf("g0v%d listed as writable; nothing here accepts a write", it.Variation)
		}
		listed[it.Variation] = true
	}
	if len(listed) != len(all) {
		t.Errorf("the list names %d variations, a read of all returns %d", len(listed), len(all))
	}
	for _, a := range all {
		if !listed[a.Variation] {
			t.Errorf("g0v%d is served but not listed", a.Variation)
		}
	}
}
