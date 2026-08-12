/*
 * IEC 60870-5-101/104 protocol drivers for {json:scada} - helper tests
 * {json:scada} - Copyright (c) 2020 - 2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 */

package mongoutil

import (
	"math"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestToU32(t *testing.T) {
	dec, err := bson.ParseDecimal128("1001")
	if err != nil {
		t.Fatalf("ParseDecimal128: %s", err)
	}
	cases := []struct {
		name string
		val  interface{}
		want uint32
	}{
		{"string", "1001", 1001},
		{"string float", " 1001.0 ", 1001},
		{"string invalid", "abc", 0},
		{"double", float64(1001), 1001},
		{"int32", int32(1001), 1001},
		{"int64", int64(1001), 1001},
		{"decimal128", dec, 1001},
		{"bool", true, 1},
		{"nil", nil, 0},
		{"negative", float64(-1), 0},
		{"over range", float64(math.MaxUint32) * 2, math.MaxUint32},
	}
	for _, c := range cases {
		if got := ToU32(c.val); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

// TestAddrMatch checks the query predicate accepts both representations.
func TestAddrMatch(t *testing.T) {
	m := AddrMatch(1001)
	in, ok := m["$in"].(bson.A)
	if !ok || len(in) != 2 {
		t.Fatalf("unexpected predicate: %v", m)
	}
	if in[0] != 1001 || in[1] != "1001" {
		t.Errorf("got %v, want [1001 \"1001\"]", in)
	}
}
