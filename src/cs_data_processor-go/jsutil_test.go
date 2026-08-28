package main

import (
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Reference values produced by Node.js (String(v), String(parseFloat(v.toFixed(4))),
// String(parseFloat(v.toFixed(3)))).
func TestJsNumberToString(t *testing.T) {
	cases := []struct {
		v                   float64
		str, fixed4, fixed3 string
	}{
		{0, "0", "0", "0"},
		{-0.0, "0", "0", "0"},
		{1, "1", "1", "1"},
		{-1, "-1", "-1", "-1"},
		{0.1, "0.1", "0.1", "0.1"},
		{1.5, "1.5", "1.5", "1.5"},
		{1e21, "1e+21", "1e+21", "1e+21"},
		{1e-7, "1e-7", "0", "0"},
		{0.000001, "0.000001", "0", "0"},
		{123456789012345680000, "123456789012345680000", "123456789012345680000", "123456789012345680000"},
		{1.0 / 3.0, "0.3333333333333333", "0.3333", "0.333"},
		{100, "100", "100", "100"},
		{-1.234e-7, "-1.234e-7", "0", "0"},
		{5e-324, "5e-324", "0", "0"},
		{1.7976931348623157e308, "1.7976931348623157e+308", "1.7976931348623157e+308", "1.7976931348623157e+308"},
		{3.14159265358979, "3.14159265358979", "3.1416", "3.142"},
		{12345.678901234, "12345.678901234", "12345.6789", "12345.679"},
		{2.5, "2.5", "2.5", "2.5"},
		{0.5, "0.5", "0.5", "0.5"},
		{-2.5, "-2.5", "-2.5", "-2.5"},
		{1e20, "100000000000000000000", "100000000000000000000", "100000000000000000000"},
		{255.999999, "255.999999", "256", "256"},
	}
	for _, c := range cases {
		if got := jsNumberToString(c.v); got != c.str {
			t.Errorf("jsNumberToString(%v) = %q, want %q", c.v, got, c.str)
		}
		if got := jsFixedString(c.v, 4); got != c.fixed4 {
			t.Errorf("jsFixedString(%v,4) = %q, want %q", c.v, got, c.fixed4)
		}
		if got := jsFixedString(c.v, 3); got != c.fixed3 {
			t.Errorf("jsFixedString(%v,3) = %q, want %q", c.v, got, c.fixed3)
		}
	}
}

func TestJsToStringRadix2(t *testing.T) {
	cases := []struct {
		v    float64
		want string
	}{
		{0, "0"}, {1, "1"}, {5, "101"}, {255, "11111111"}, {-255, "-11111111"},
		{1.5, "1.1"}, {0.25, "0.01"}, {65535, "1111111111111111"},
		{4294967295, "11111111111111111111111111111111"}, {-1, "-1"}, {10.75, "1010.11"},
	}
	for _, c := range cases {
		if got := jsToStringRadix2(c.v); got != c.want {
			t.Errorf("jsToStringRadix2(%v) = %q, want %q", c.v, got, c.want)
		}
	}
}

func TestJsIsNaNString(t *testing.T) {
	cases := []struct {
		s    string
		want bool
	}{
		{"", false}, {" ", false}, {"0", false}, {"12", false}, {"abc", true},
		{"0x1f", false}, {"1e5", false}, {`"x"`, true}, {`{"a":1}`, true},
		{"-3.5", false}, {"Infinity", false}, {"12abc", true},
	}
	for _, c := range cases {
		if got := jsIsNaNString(c.s); got != c.want {
			t.Errorf("jsIsNaNString(%q) = %v, want %v", c.s, got, c.want)
		}
	}
}

func TestBsonDocToJSONKeepsOrderAndOverrides(t *testing.T) {
	when := time.Date(2024, 3, 4, 5, 6, 7, 890000000, time.UTC)
	doc := bson.D{
		{Key: "_id", Value: 1234.0},
		{Key: "tag", Value: "A~B'C"},
		{Key: "value", Value: 1.0},
		{Key: "valueString", Value: "old"},
		{Key: "timeTag", Value: when},
		{Key: "nested", Value: bson.D{{Key: "a", Value: int32(3)}, {Key: "b", Value: nil}}},
		{Key: "list", Value: bson.A{1.0, "x", true}},
	}
	raw, err := bson.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	got := bsonDocToJSON(bson.Raw(raw), nil, nil)
	want := `{"_id":1234,"tag":"A~B'C","value":1,"valueString":"old",` +
		`"timeTag":"2024-03-04T05:06:07.890Z","nested":{"a":3,"b":null},"list":[1,"x",true]}`
	if got != want {
		t.Errorf("plain:\n got %s\nwant %s", got, want)
	}

	overrides := map[string]jsonValue{
		"value":       jvNumber(42.5),
		"valueString": jvString("new"),
		"valueJson":   jvString(""),
		"alarmed":     jvBool(true),
	}
	order := []string{"value", "valueString", "valueJson", "alarmed"}
	got = bsonDocToJSON(bson.Raw(raw), overrides, order)
	want = `{"_id":1234,"tag":"A~B'C","value":42.5,"valueString":"new",` +
		`"timeTag":"2024-03-04T05:06:07.890Z","nested":{"a":3,"b":null},"list":[1,"x",true],` +
		`"valueJson":"","alarmed":true}`
	if got != want {
		t.Errorf("overridden:\n got %s\nwant %s", got, want)
	}
}

func TestJsJSONStringEscaping(t *testing.T) {
	if got := jsJSONString("a\"b\\c\nd\te\x01f/g<h>"); got != `"a\"b\\c\nd\te\u0001f/g<h>"` {
		t.Errorf("got %s", got)
	}
	// non ASCII must be emitted verbatim, like JSON.stringify does
	if got := jsJSONString("çã⤉"); got != "\"çã⤉\"" {
		t.Errorf("got %s", got)
	}
}

func TestHistogramPercentiles(t *testing.T) {
	h := NewHistogram()
	for i := 1; i <= 1000; i++ {
		h.Observe(int64(i) * 1000) // 1 ms .. 1000 ms
	}
	s := h.Snapshot()
	if s.Count != 1000 {
		t.Fatalf("count = %v", s.Count)
	}
	within := func(got, want, tolPct float64) bool {
		if want == 0 {
			return got == 0
		}
		d := (got - want) / want
		if d < 0 {
			d = -d
		}
		return d <= tolPct
	}
	if !within(s.P50Ms, 500, 0.03) {
		t.Errorf("p50 = %v, want ~500", s.P50Ms)
	}
	if !within(s.P90Ms, 900, 0.03) {
		t.Errorf("p90 = %v, want ~900", s.P90Ms)
	}
	if !within(s.P99Ms, 990, 0.03) {
		t.Errorf("p99 = %v, want ~990", s.P99Ms)
	}
	if s.MinMs != 1 || s.MaxMs != 1000 {
		t.Errorf("min/max = %v/%v", s.MinMs, s.MaxMs)
	}
	if !within(s.AvgMs, 500.5, 0.01) {
		t.Errorf("avg = %v", s.AvgMs)
	}
}
