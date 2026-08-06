package main

import (
	"encoding/json"
	"math"
	"testing"
	"time"

	"github.com/dscsystems/go-iec61850/mms"
	"github.com/dscsystems/go-iec61850/model"
)

func dbpos(b0, b1 bool) *mms.Value {
	v := mms.NewBitString(2)
	v.SetBit(0, b0)
	v.SetBit(1, b1)
	return v
}

func TestGetRefFc(t *testing.T) {
	cases := []struct {
		in      string
		wantRef string
		wantFC  model.FC
	}{
		{"DemoProtCtrl/Obj1XCBR1$ST$Pos", "DemoProtCtrl/Obj1XCBR1.Pos", model.ST},
		{"IED/GGIO1$MX$AnIn1$mag$f", "IED/GGIO1.AnIn1.mag.f", model.MX},
		{"IED/LLN0$CO$Beh", "IED/LLN0.Beh", model.CO},
		{"IED/GGIO1$SR$Something", "IED/GGIO1.Something", model.FCNone}, // SR has no counterpart
		{"IED/GGIO1$NoFc$X", "IED/GGIO1.NoFc.X", model.FCNone},
	}
	for _, c := range cases {
		ref, fc := getRefFc(c.in)
		if ref != c.wantRef || fc != c.wantFC {
			t.Errorf("getRefFc(%q) = (%q,%v), want (%q,%v)", c.in, ref, fc, c.wantRef, c.wantFC)
		}
	}
}

func TestGetRefFc2(t *testing.T) {
	ref, fc := getRefFc2("IED/GGIO1.AnIn1[MX]")
	if ref != "IED/GGIO1.AnIn1" || fc != model.MX {
		t.Errorf("getRefFc2 = (%q,%v)", ref, fc)
	}
	ref, fc = getRefFc2("IED/GGIO1.AnIn1")
	if ref != "IED/GGIO1.AnIn1" || fc != model.FCNone {
		t.Errorf("getRefFc2 without FC = (%q,%v)", ref, fc)
	}
}

func TestParseFCOrST(t *testing.T) {
	// An unparseable functional constraint must land on ST, as the zero of
	// libiec61850's enum does in the C# driver, not on FCNone.
	if got := parseFCOrST(""); got != model.ST {
		t.Errorf("parseFCOrST(\"\") = %v, want ST", got)
	}
	if got := parseFCOrST("nonsense"); got != model.ST {
		t.Errorf("parseFCOrST(nonsense) = %v, want ST", got)
	}
	if got := parseFCOrST(" mx "); got != model.MX {
		t.Errorf("parseFCOrST(mx) = %v, want MX", got)
	}
}

func TestBitStringConversions(t *testing.T) {
	v := mms.NewBitString(4)
	v.SetBit(0, true) // first bit
	// big endian: first bit is the most significant of 4 -> 0b1000 = 8
	if got := bitStringToUint32BE(v); got != 8 {
		t.Errorf("bitStringToUint32BE = %d, want 8", got)
	}
	// little endian: first bit has weight 1
	if got := bitStringToUint32(v); got != 1 {
		t.Errorf("bitStringToUint32 = %d, want 1", got)
	}
	if got := bitStringAsString(v); got != "1000" {
		t.Errorf("bitStringAsString = %q, want 1000", got)
	}
}

func TestDoubleState(t *testing.T) {
	cases := []struct {
		b0, b1            bool
		want              float64
		failed, transient bool
	}{
		{false, false, 0, true, true},  // 00 intermediate
		{false, true, 0, false, false}, // 01 off
		{true, false, 1, false, false}, // 10 on
		{true, true, 1, true, false},   // 11 bad
	}
	for _, c := range cases {
		v := dbpos(c.b0, c.b1)
		got, isBinary := mmsGetDoubleVal(v)
		if got != c.want || !isBinary {
			t.Errorf("dbpos(%v,%v) = (%v,%v), want (%v,true)", c.b0, c.b1, got, isBinary, c.want)
		}
		if mmsTestDoubleStateFailed(v) != c.failed {
			t.Errorf("dbpos(%v,%v) failed = %v, want %v", c.b0, c.b1, !c.failed, c.failed)
		}
		if mmsTestDoubleStateTransient(v) != c.transient {
			t.Errorf("dbpos(%v,%v) transient = %v, want %v", c.b0, c.b1, !c.transient, c.transient)
		}
	}
}

func TestQualityFailed(t *testing.T) {
	good := model.QualityGood.Value()
	invalid := model.QualityGood.WithValidity(model.ValidityInvalid).Value()
	questionable := model.QualityGood.WithValidity(model.ValidityQuestionable).Value()

	// A structure carrying a quality attribute is judged by its validity.
	stGood := mms.NewStructure(dbpos(false, true), good, mms.NewUTCTimeNow())
	if mmsGetQualityFailed(stGood) {
		t.Error("good quality reported as failed")
	}
	stBad := mms.NewStructure(dbpos(false, true), invalid, mms.NewUTCTimeNow())
	if !mmsGetQualityFailed(stBad) {
		t.Error("invalid quality not reported as failed")
	}
	stQ := mms.NewStructure(dbpos(false, true), questionable, mms.NewUTCTimeNow())
	if !mmsGetQualityFailed(stQ) {
		t.Error("questionable quality not reported as failed")
	}

	// A structure with no quality attribute falls back to its first member.
	noQ := mms.NewStructure(dbpos(true, true))
	if !mmsGetQualityFailed(noQ) {
		t.Error("inconsistent double point not reported as failed")
	}
}

func TestGetNumericValFromMV(t *testing.T) {
	// MV: { mag: { f }, q, t }
	mv := mms.NewStructure(
		mms.NewStructure(mms.NewFloat32(12.5)),
		model.QualityGood.Value(),
		mms.NewUTCTimeNow(),
	)
	got, isBinary := mmsGetNumericVal(mv)
	if got != 12.5 || isBinary {
		t.Errorf("MV numeric = (%v,%v), want (12.5,false)", got, isBinary)
	}
}

func TestGetNumericValFromDoublePointStructure(t *testing.T) {
	// DPS: { stVal(2-bit), q, t } — no numeric member, so the first member
	// decides, and it is a double point.
	dps := mms.NewStructure(dbpos(true, false), model.QualityGood.Value(), mms.NewUTCTimeNow())
	got, isBinary := mmsGetNumericVal(dps)
	if got != 1 || !isBinary {
		t.Errorf("DPS numeric = (%v,%v), want (1,true)", got, isBinary)
	}
}

func TestGetTimestamp(t *testing.T) {
	when := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	st := mms.NewStructure(mms.NewFloat32(1), model.QualityGood.Value(), mms.NewUTCTime(when, mms.TimeAccuracy(10)))
	got := mmsGetTimestamp(st)
	if diff := int64(got) - when.UnixMilli(); diff < -1 || diff > 1 {
		t.Errorf("timestamp = %d, want ~%d", got, when.UnixMilli())
	}
	if mmsGetTimestamp(mms.NewStructure(mms.NewFloat32(1))) != 0 {
		t.Error("timestamp found where there is none")
	}
}

func TestMmsToString(t *testing.T) {
	cases := []struct {
		v    *mms.Value
		want string
	}{
		{mms.NewBool(true), "True"},
		{mms.NewBool(false), "False"},
		{mms.NewInt32(-7), "-7"},
		{mms.NewUint32(9), "9"},
		{mms.NewVisibleString("hi"), "hi"},
		{mms.NewOctetString([]byte{0xAA, 0x0B}), "AA-0B"},
		{dbpos(true, false), "10"},
		{mms.NewFloat64(0.1), "0.1"},
		{mms.NewFloat64(1e21), "1E+21"},
	}
	for _, c := range cases {
		if got := mmsToString(c.v); got != c.want {
			t.Errorf("mmsToString(%v) = %q, want %q", c.v.Type(), got, c.want)
		}
	}
	if got := mmsToString(mms.NewUTCTime(time.Date(2026, 8, 5, 14, 3, 4, 0, time.UTC), mms.TimeAccuracy(10))); got != "8/5/2026 2:03:04 PM +00:00" {
		t.Errorf("mmsToString(UTCTime) = %q", got)
	}
}

func TestFormatDouble(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{0.1, "0.1"},
		{1, "1"},
		{-0, "0"},
		{1e-7, "1E-07"},
		{math.NaN(), "NaN"},
		{math.Inf(1), "Infinity"},
		{math.Inf(-1), "-Infinity"},
	}
	for _, c := range cases {
		if got := formatDouble(c.in); got != c.want {
			t.Errorf("formatDouble(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestGetStringValueIsValidJSON(t *testing.T) {
	values := []*mms.Value{
		mms.NewFloat32(1.5),
		mms.NewVisibleString(`quote " and \ backslash`),
		mms.NewStructure(mms.NewFloat32(1)),
		mms.NewStructure(dbpos(false, true), model.QualityGood.Value(), mms.NewUTCTimeNow()),
		mms.NewStructure(mms.NewStructure(mms.NewFloat32(2)), model.QualityGood.Value()),
		mms.NewArray(mms.NewInt32(1), mms.NewInt32(2)),
	}
	for _, v := range values {
		s := mmsGetStringValue(v)
		var out any
		if err := json.Unmarshal([]byte(s), &out); err != nil {
			t.Errorf("mmsGetStringValue(%v) = %q, not valid JSON: %v", v.Type(), s, err)
		}
	}

	// A one-member container renders as its member, not as an array.
	if got := mmsGetStringValue(mms.NewStructure(mms.NewFloat32(1))); got != `"1"` {
		t.Errorf("single member structure = %q, want \"1\"", got)
	}
	// Several members render as an array of strings.
	if got := mmsGetStringValue(mms.NewArray(mms.NewInt32(1), mms.NewInt32(2))); got != `["1","2"]` {
		t.Errorf("array = %q", got)
	}
}

func TestMmsTypeName(t *testing.T) {
	cases := map[mms.Type]string{
		mms.TypeStructure:     "MMS_STRUCTURE",
		mms.TypeArray:         "MMS_ARRAY",
		mms.TypeBoolean:       "MMS_BOOLEAN",
		mms.TypeBitString:     "MMS_BIT_STRING",
		mms.TypeInteger:       "MMS_INTEGER",
		mms.TypeUnsigned:      "MMS_UNSIGNED",
		mms.TypeFloat32:       "MMS_FLOAT",
		mms.TypeFloat64:       "MMS_FLOAT",
		mms.TypeOctetString:   "MMS_OCTET_STRING",
		mms.TypeVisibleString: "MMS_VISIBLE_STRING",
		mms.TypeMMSString:     "MMS_STRING",
		mms.TypeUTCTime:       "MMS_UTC_TIME",
		mms.TypeBinaryTime:    "MMS_BINARY_TIME",
		mms.TypeNone:          "MMS_DATA_ACCESS_ERROR",
	}
	for typ, want := range cases {
		if got := mmsTypeName(typ); got != want {
			t.Errorf("mmsTypeName(%v) = %q, want %q", typ, got, want)
		}
	}
}

func TestEntryIDString(t *testing.T) {
	if got := entryIDString([]byte{0, 1, 0xAB}); got != "00-01-AB" {
		t.Errorf("entryIDString = %q", got)
	}
}
