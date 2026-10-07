package main

import (
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// decodeDoc round-trips a document through BSON, so sub-documents arrive the
// way MongoDB delivers them (bson.D), not as the bson.M they were built from.
func decodeDoc(t *testing.T, in bson.M) bson.M {
	t.Helper()
	raw, err := bson.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out bson.M
	if err := bson.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// A connection that never saved an EntryID has no lastReportIds field; the
// first buffered report must still be recorded, not panic the driver.
func TestConnectionWithoutLastReportIds(t *testing.T) {
	conn := connectionFromDoc(decodeDoc(t, bson.M{"protocolConnectionNumber": 81, "name": "IED"}))
	conn.SetLastReportID("LD/LLN0.BR.brcb01", []byte{1, 2, 3, 4, 5, 6, 7, 8})
	if id, ok := conn.LastReportID("LD/LLN0.BR.brcb01"); !ok || len(id) != 8 {
		t.Errorf("LastReportID = %v, %v", id, ok)
	}
}

// A saved EntryID is read back, which is what the buffered report resync
// after a restart relies on.
func TestConnectionReadsSavedLastReportIds(t *testing.T) {
	saved := []byte{0, 0, 0, 0, 0, 0, 0x12, 0x34}
	conn := connectionFromDoc(decodeDoc(t, bson.M{
		"protocolConnectionNumber": 81,
		"name":                     "IED",
		"lastReportIds":            bson.M{"LD/LLN0.BR.brcb01": bson.Binary{Data: saved}},
	}))
	id, ok := conn.LastReportID("LD/LLN0.BR.brcb01")
	if !ok || string(id) != string(saved) {
		t.Errorf("LastReportID = %x, %v; want %x", id, ok, saved)
	}
}
