package main

import (
	"testing"
	"time"

	"github.com/riclolsen/tase2/tase2"
)

func TestGetICCPType(t *testing.T) {
	cases := []struct {
		name string
		tag  rtData
		want tase2.ICCPType
	}{
		{"digital", rtData{Type: "digital"}, tase2.ICCPTypeStateQTimeTagExtended},
		{"analog float", rtData{Type: "analog"}, tase2.ICCPTypeRealQTimeTagExtended},
		{"analog float32 asdu", rtData{Type: "analog", ProtocolSourceASDU: "float32"}, tase2.ICCPTypeRealQTimeTagExtended},
		{"analog int32", rtData{Type: "analog", ProtocolSourceASDU: "int32"}, tase2.ICCPTypeDiscreteQTimeTagExtended},
		{"analog uint16", rtData{Type: "analog", ProtocolSourceASDU: "uint16"}, tase2.ICCPTypeDiscreteQTimeTagExtended},
		{"analog int64", rtData{Type: "analog", ProtocolSourceASDU: "int64"}, tase2.ICCPTypeDiscreteQTimeTagExtended},
		{"string", rtData{Type: "string"}, tase2.ICCPTypeUnknown},
		{"json", rtData{Type: "json"}, tase2.ICCPTypeUnknown},
	}
	for _, c := range cases {
		if got := getICCPType(c.tag); got != c.want {
			t.Errorf("%s: getICCPType = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestConvertToICCPValueRoundTrip(t *testing.T) {
	// Source time with a sub-second part: the millisecond must survive, the
	// microseconds are truncated.
	ts := time.Date(2026, 7, 5, 11, 30, 0, 123456789, time.UTC)
	wantTS := time.Date(2026, 7, 5, 11, 30, 0, 123000000, time.UTC)

	// Analog with source timestamp and invalid quality
	tag := rtData{Type: "analog", Value: 123.25, Invalid: true, TimeTagAtSource: &ts, TimeTagAtSourceOk: true}
	dp := tase2.DecodeICCP(convertToICCPValue(tag, getICCPType(tag)))
	if dp.Type != tase2.ICCPTypeRealQTimeTagExtended {
		t.Fatalf("decoded type = %v, want RealQTimeTagExtended", dp.Type)
	}
	if dp.Real == nil || *dp.Real < 123.2 || *dp.Real > 123.3 {
		t.Errorf("decoded real = %v, want ~123.25", dp.Real)
	}
	if dp.Quality == nil || dp.Quality.Validity != tase2.QualityInvalid {
		t.Errorf("decoded quality = %+v, want invalid", dp.Quality)
	}
	if got, ok := dp.Time(); !ok || !got.Equal(wantTS) {
		t.Errorf("decoded time = %v (ok=%v), want %v", got, ok, wantTS)
	}

	// Digital on, stamped with the source time to the millisecond
	tag = rtData{Type: "digital", Value: 1, TimeTagAtSource: &ts, TimeTagAtSourceOk: true}
	dp = tase2.DecodeICCP(convertToICCPValue(tag, getICCPType(tag)))
	if dp.Type != tase2.ICCPTypeStateQTimeTagExtended {
		t.Fatalf("digital: decoded type = %v, want StateQTimeTagExtended", dp.Type)
	}
	if dp.State == nil || *dp.State != tase2.StateOn {
		t.Errorf("digital 1: decoded state = %v, want StateOn", dp.State)
	}
	if dp.Milliseconds == nil || *dp.Milliseconds != 123 {
		t.Errorf("digital: decoded milliseconds = %v, want 123", dp.Milliseconds)
	}

	// No source time: stamped with the current time (GMT based, not a
	// time-of-day value).
	tag = rtData{Type: "analog", Value: 1234567, ProtocolSourceASDU: "int32"}
	before := time.Now().Truncate(time.Millisecond)
	dp = tase2.DecodeICCP(convertToICCPValue(tag, getICCPType(tag)))
	if dp.Type != tase2.ICCPTypeDiscreteQTimeTagExtended {
		t.Fatalf("int32 analog: decoded type = %v, want DiscreteQTimeTagExtended", dp.Type)
	}
	if dp.Discrete == nil || *dp.Discrete != 1234567 {
		t.Errorf("int32 analog: decoded discrete = %v, want 1234567 (exact)", dp.Discrete)
	}
	if got, ok := dp.Time(); !ok || got.Before(before) || got.After(time.Now()) {
		t.Errorf("int32 analog: decoded time = %v (ok=%v), want between %v and now", got, ok, before)
	}

	// Legacy second-resolution types now carry GMTBasedS seconds.
	dp = tase2.DecodeICCP(convertToICCPValue(rtData{Type: "analog", Value: 1, TimeTagAtSource: &ts, TimeTagAtSourceOk: true}, tase2.ICCPTypeRealQTimeTag))
	if dp.TimeTag == nil || *dp.TimeTag != ts.Unix() {
		t.Errorf("RealQTimeTag: decoded timetag = %v, want %d", dp.TimeTag, ts.Unix())
	}
}

func TestApplyCommandConversion(t *testing.T) {
	cases := []struct {
		name   string
		value  float64
		doc    rtData
		want   float64
		wantSt string
		origSt string
	}{
		{"digital direct on", 1, rtData{Type: "digital", Kconv1: 1.0}, 1, "true", "true"},
		{"digital direct off", 0, rtData{Type: "digital", Kconv1: 1.0}, 0, "false", "false"},
		{"digital direct nonzero 0.6", 0.6, rtData{Type: "digital"}, 1, "1", "0.600000"},
		{"digital direct nonzero 0.4", 0.4, rtData{Type: "digital"}, 1, "1", "0.400000"},
		{"digital direct non-boolean", 3, rtData{Type: "digital"}, 1, "1", "3"},
		{"digital inverted on", 1, rtData{Type: "digital", Kconv1: -1.0}, 0, "false", "true"},
		{"digital inverted off", 0, rtData{Type: "digital", Kconv1: -1.0}, 1, "true", "false"},
		{"digital inverted int kconv", 1, rtData{Type: "digital", Kconv1: int32(-1)}, 0, "0", "1"},
		{"analog scaled", 10, rtData{Type: "analog", Kconv1: 2.0, Kconv2: 5.0}, 25, "25", "10.000000"},
		{"analog defaults", 12.5, rtData{Type: "analog"}, 12.5, "12.500000", "12.500000"},
		{"analog offset only", 3, rtData{Type: "analog", Kconv2: 1.5}, 4.5, "4.5", "3"},
		{"string type untouched", 7, rtData{Type: "string", Kconv1: -1.0}, 7, "7", "7"},
	}

	for _, c := range cases {
		got := applyCommandConversion(c.value, c.doc)
		if got != c.want {
			t.Errorf("%s: applyCommandConversion(%v) = %v, want %v", c.name, c.value, got, c.want)
		}
		st := c.origSt
		if got != c.value {
			st = commandValueString(got, c.origSt)
		}
		if st != c.wantSt {
			t.Errorf("%s: valueString = %q, want %q", c.name, st, c.wantSt)
		}
	}
}

func TestSanitizePointName(t *testing.T) {
	cases := map[string]string{
		"KAW2AL-21XCBR5217----K": "KAW2AL_21XCBR5217____K",
		"9starts_with_digit":     "X9starts_with_digit",
		"":                       "X_unnamed_",
	}
	for in, want := range cases {
		if got := sanitizePointName(in); got != want {
			t.Errorf("sanitizePointName(%q) = %q, want %q", in, got, want)
		}
	}
}
