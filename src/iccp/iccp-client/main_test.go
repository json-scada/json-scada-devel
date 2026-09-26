package main

import (
	"testing"
	"time"

	"github.com/riclolsen/tase2/tase2"
)

func testMapping(item string) tagMapping {
	return tagMapping{
		tag: rtData{
			Tag:                         "TEST_" + item,
			ProtocolSourceObjectAddress: "SUB_A/" + item,
			ProtocolSourceASDU:          "realq",
		},
		ref: tase2.ObjectRef{Domain: "SUB_A", Item: item},
	}
}

func TestDataValueToUpdateRealQGood(t *testing.T) {
	now := time.Now()
	dv := tase2.NewRealQ(230.5, tase2.QualityGood)
	upd := dataValueToUpdate(dv, testMapping("ICCP_RealQ_01"), now, 0)

	if upd.value < 230.4 || upd.value > 230.6 {
		t.Errorf("value = %v, want ~230.5", upd.value)
	}
	if upd.invalid || upd.notTopical || upd.substituted {
		t.Errorf("quality flags = inv:%v nt:%v sub:%v, want all false", upd.invalid, upd.notTopical, upd.substituted)
	}
	if upd.timeTagAtSourceOk {
		t.Error("timeTagAtSourceOk = true, want false (no timetag in RealQ)")
	}
}

func TestDataValueToUpdateRealQTimeTagInvalid(t *testing.T) {
	now := time.Now()
	nowUTC := now.UTC()

	q := &tase2.Quality{Validity: tase2.QualityInvalid, Source: tase2.SourceTelemetered}
	dv := tase2.NewRealQTimeTag(42.0, q, tase2.TimeStampFrom(now))
	upd := dataValueToUpdate(dv, testMapping("ICCP_RealQTimeTag_01"), now, 0)

	if upd.value < 41.9 || upd.value > 42.1 {
		t.Errorf("value = %v, want ~42.0", upd.value)
	}
	if !upd.invalid {
		t.Error("invalid = false, want true")
	}
	if !upd.timeTagAtSourceOk {
		t.Fatal("timeTagAtSourceOk = false, want true")
	}
	diff := upd.timeTagAtSource.Sub(nowUTC)
	if diff < -2*time.Second || diff > 2*time.Second {
		t.Errorf("timeTagAtSource = %v, want ~%v (diff %v)", upd.timeTagAtSource, nowUTC, diff)
	}
}

func TestDataValueToUpdateStateQTimeTag(t *testing.T) {
	now := time.Now()
	dv := tase2.NewStateQTimeTag(tase2.StateOn, tase2.QualityGood, 1000)
	upd := dataValueToUpdate(dv, testMapping("ICCP_State_01"), now, 0)

	if upd.value != float64(tase2.StateOn) {
		t.Errorf("value = %v, want %v (StateOn)", upd.value, float64(tase2.StateOn))
	}
	if upd.invalid {
		t.Error("invalid = true, want false")
	}
	if !upd.timeTagAtSourceOk {
		t.Error("timeTagAtSourceOk = false, want true")
	}
}

func TestDataValueToUpdateSubstituted(t *testing.T) {
	q := &tase2.Quality{Validity: "questionable", Source: "substituted"}
	dv := tase2.NewDiscreteQ(7, q)
	upd := dataValueToUpdate(dv, testMapping("ICCP_DiscreteQ_01"), time.Now(), 0)

	if upd.value != 7 {
		t.Errorf("value = %v, want 7", upd.value)
	}
	if !upd.notTopical {
		t.Error("notTopical = false, want true (questionable)")
	}
	if !upd.substituted {
		t.Error("substituted = false, want true")
	}
}

func TestDataValueToUpdatePlainScalars(t *testing.T) {
	now := time.Now()

	upd := dataValueToUpdate(tase2.NewFloat32Value(1.5), testMapping("Real_01"), now, 0)
	if upd.value != 1.5 {
		t.Errorf("float value = %v, want 1.5", upd.value)
	}

	upd = dataValueToUpdate(tase2.NewBooleanValue(true), testMapping("Bool_01"), now, 0)
	if upd.value != 1 || upd.valueString != "true" {
		t.Errorf("bool value = %v/%q, want 1/\"true\"", upd.value, upd.valueString)
	}

	upd = dataValueToUpdate(nil, testMapping("Nil_01"), now, 0)
	if !upd.invalid {
		t.Error("nil value: invalid = false, want true")
	}
}

func TestDataValueToUpdateQTimeTagExtended(t *testing.T) {
	src := time.Date(2026, 9, 26, 8, 53, 7, 123000000, time.UTC)
	cases := []struct {
		name string
		dv   *tase2.DataValue
	}{
		{"real", tase2.NewRealQTimeTagExtended(1.5, tase2.QualityGood, src)},
		{"discrete", tase2.NewDiscreteQTimeTagExtended(7, tase2.QualityGood, src)},
		{"state", tase2.NewStateQTimeTagExtended(tase2.StateOn, tase2.QualityGood, src)},
	}
	for _, c := range cases {
		upd := dataValueToUpdate(c.dv, testMapping("Ext_01"), time.Now(), 0)
		if !upd.timeTagAtSourceOk || !upd.timeTagAtSource.Equal(src) {
			t.Errorf("%s: timeTagAtSource = %v (ok=%v), want %v (ms kept)", c.name, upd.timeTagAtSource, upd.timeTagAtSourceOk, src)
		}
	}

	// HoursShift: peer stamps local time 3h ahead of UTC; shift -3 corrects it.
	upd := dataValueToUpdate(cases[0].dv, testMapping("Ext_01"), time.Now(), -3)
	if want := src.Add(-3 * time.Hour); !upd.timeTagAtSource.Equal(want) {
		t.Errorf("hoursShift: got %v, want %v", upd.timeTagAtSource, want)
	}
}
