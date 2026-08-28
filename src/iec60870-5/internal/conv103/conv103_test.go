/*
 * IEC 60870-5-103 client driver for {json:scada} - conv103 tests
 * {json:scada} - Copyright (c) 2020 - 2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 */

package conv103

import (
	"encoding/binary"
	"testing"

	"github.com/riclolsen/go-iecp5/asdu"
	"github.com/riclolsen/go-iecp5/cs103"
)

func TestAddrRoundTrip(t *testing.T) {
	fun, inf, idx := 160, 42, 3
	a := Addr(fun, inf, idx)
	gf, gi, gx := SplitAddr(a)
	if gf != fun || gi != inf || gx != idx {
		t.Errorf("addr round trip: got (%d,%d,%d) want (%d,%d,%d)", gf, gi, gx, fun, inf, idx)
	}
}

func TestDecodeTimeTaggedEvent(t *testing.T) {
	// ASDU 1: FUN INF DPI CP32(4) SIN
	fun, inf := byte(160), byte(69)
	info := []byte{fun, inf, byte(cs103.DPIOn), 0, 0, 0, 0, 0}
	a := &cs103.ASDU{Type: cs103.TypTimeTagged, Coa: cs103.CauseSpontaneous, CommonAddr: 3, InfoObj: info}
	a.Variable.Number = 1

	res := Decode(a, 7)
	if len(res.Values) != 1 || len(res.Acks) != 0 {
		t.Fatalf("expected 1 value 0 acks, got %d/%d", len(res.Values), len(res.Acks))
	}
	v := res.Values[0]
	if v.Address != Addr(int(fun), int(inf), 0) {
		t.Errorf("address mismatch: %d", v.Address)
	}
	if v.Value != 1 || !v.IsDigital {
		t.Errorf("expected digital On, got %+v", v)
	}
	if v.Asdu != asdu.M_SP_NA_1 || v.AsduStr == "" {
		t.Errorf("expected M_SP_NA_1 with AsduStr, got %v / %q", v.Asdu, v.AsduStr)
	}
	if v.CommonAddress != 3 || v.ConnNumber != 7 {
		t.Errorf("ca/conn mismatch: %+v", v)
	}
}

func TestDecodeCommandAck(t *testing.T) {
	fun, inf := byte(160), byte(69)
	info := []byte{fun, inf, byte(cs103.DPIOn), 0, 0, 0, 0, 42}
	// cause 20 = positive command acknowledgement
	a := &cs103.ASDU{Type: cs103.TypTimeTagged, Coa: cs103.CauseCommandAckPos, CommonAddr: 3, InfoObj: info}
	a.Variable.Number = 1

	res := Decode(a, 7)
	if len(res.Acks) != 1 || len(res.Values) != 0 {
		t.Fatalf("expected 1 ack 0 values, got %d/%d", len(res.Acks), len(res.Values))
	}
	if !res.Acks[0].Ack || res.Acks[0].ObjectAddress != Addr(int(fun), int(inf), 0) {
		t.Errorf("ack mismatch: %+v", res.Acks[0])
	}
}

func TestDecodeMeasurands(t *testing.T) {
	fun, inf := byte(160), byte(148)
	// two measurands: value 2048 (half scale) and 1024 (quarter scale)
	buf := []byte{fun, inf}
	m1 := uint16(2048) << 3
	m2 := uint16(1024) << 3
	buf = binary.LittleEndian.AppendUint16(buf, m1)
	buf = binary.LittleEndian.AppendUint16(buf, m2)
	a := &cs103.ASDU{Type: cs103.TypMeasurandsI, Coa: cs103.CauseCyclic, CommonAddr: 3, InfoObj: buf}
	a.Variable.Number = 2

	res := Decode(a, 7)
	if len(res.Values) != 2 {
		t.Fatalf("expected 2 measurands, got %d", len(res.Values))
	}
	if res.Values[0].Address != Addr(int(fun), int(inf), 0) ||
		res.Values[1].Address != Addr(int(fun), int(inf), 1) {
		t.Errorf("measurand indices wrong: %d %d", res.Values[0].Address, res.Values[1].Address)
	}
	if res.Values[0].Value < 0.49 || res.Values[0].Value > 0.51 {
		t.Errorf("measurand 0 value: %g", res.Values[0].Value)
	}
	if res.Values[0].IsDigital {
		t.Errorf("measurands must be analog")
	}
}

func TestGeneralCommandParams(t *testing.T) {
	fun, inf, dco := GeneralCommandParams(Addr(160, 69, 0), 1)
	if fun != 160 || inf != 69 || dco != cs103.DCOOn {
		t.Errorf("cmd params: %d %d %v", fun, inf, dco)
	}
	_, _, dco = GeneralCommandParams(Addr(160, 69, 0), 0)
	if dco != cs103.DCOOff {
		t.Errorf("expected DCOOff, got %v", dco)
	}
}
