/*
 * IEC 60870-5-101/104 protocol drivers for {json:scada} - U32 decoding tests
 * {json:scada} - Copyright (c) 2020 - 2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 */

package model

import (
	"math"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// decodeU32 round-trips one BSON value through a document field.
func decodeU32(t *testing.T, val interface{}) U32 {
	t.Helper()
	data, err := bson.Marshal(bson.M{"v": val})
	if err != nil {
		t.Fatalf("marshal %v: %s", val, err)
	}
	var out struct {
		V U32 `bson:"v"`
	}
	if err := bson.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal %v: %s", val, err)
	}
	return out.V
}

func TestU32AcceptsStringAndNumericTypes(t *testing.T) {
	dec, err := bson.ParseDecimal128("1001")
	if err != nil {
		t.Fatalf("ParseDecimal128: %s", err)
	}
	cases := []struct {
		name string
		val  interface{}
		want U32
	}{
		{"string", "1001", 1001},
		{"string with spaces", "  1001 ", 1001},
		{"string float", "1001.0", 1001},
		{"string empty", "", 0},
		{"string invalid", "abc", 0},
		{"string negative", "-5", 0},
		{"string big", "4294967295", math.MaxUint32},
		{"double", float64(1001), 1001},
		{"double fractional", 1001.7, 1001},
		{"int32", int32(1001), 1001},
		{"int64", int64(1001), 1001},
		{"decimal128", dec, 1001},
		{"bool true", true, 1},
		{"bool false", false, 0},
		{"null", nil, 0},
		{"negative", float64(-1), 0},
		{"over range", float64(math.MaxUint32) * 2, math.MaxUint32},
		{"max", int64(math.MaxUint32), math.MaxUint32},
	}
	for _, c := range cases {
		if got := decodeU32(t, c.val); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestU32MissingFieldIsZero(t *testing.T) {
	data, err := bson.Marshal(bson.M{"other": 1})
	if err != nil {
		t.Fatalf("marshal: %s", err)
	}
	var out struct {
		V U32 `bson:"v"`
	}
	if err := bson.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal: %s", err)
	}
	if out.V != 0 {
		t.Errorf("missing field: got %d, want 0", out.V)
	}
}

// TestPointAddressesMixedTypes decodes a realtimeData-like document where the
// source addresses are strings and the destination addresses mix strings with
// numeric types, as the drivers must accept both.
func TestPointAddressesMixedTypes(t *testing.T) {
	doc := bson.M{
		"_id":                            float64(123),
		"tag":                            "TEST",
		"value":                          float64(1),
		"protocolSourceConnectionNumber": float64(1),
		"protocolSourceCommonAddress":    "3",
		"protocolSourceObjectAddress":    "12345",
		"protocolSourceASDU":             "45",
		"protocolDestinations": bson.A{
			bson.M{
				"protocolDestinationConnectionNumber": float64(2),
				"protocolDestinationCommonAddress":    int32(7),
				"protocolDestinationObjectAddress":    "1002",
				"protocolDestinationASDU":             int64(13),
			},
		},
	}
	data, err := bson.Marshal(doc)
	if err != nil {
		t.Fatalf("marshal: %s", err)
	}
	var point RtDataPoint
	if err := bson.Unmarshal(data, &point); err != nil {
		t.Fatalf("unmarshal: %s", err)
	}
	if point.ProtocolSourceCommonAddress != 3 ||
		point.ProtocolSourceObjectAddress != 12345 ||
		point.ProtocolSourceASDU != 45 {
		t.Errorf("source addresses: got CA %d IOA %d ASDU %d",
			point.ProtocolSourceCommonAddress, point.ProtocolSourceObjectAddress, point.ProtocolSourceASDU)
	}
	if len(point.ProtocolDestinations) != 1 {
		t.Fatalf("destinations: got %d, want 1", len(point.ProtocolDestinations))
	}
	dst := point.ProtocolDestinations[0]
	if dst.CommonAddress != 7 || dst.ObjectAddress != 1002 || dst.ASDU != 13 {
		t.Errorf("destination addresses: got CA %d IOA %d ASDU %d",
			dst.CommonAddress, dst.ObjectAddress, dst.ASDU)
	}
}
