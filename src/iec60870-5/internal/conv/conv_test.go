/*
 * IEC 60870-5-101/104 protocol drivers for {json:scada} - conv tests
 * {json:scada} - Copyright (c) 2020 - 2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 */

package conv

import (
	"testing"
	"time"

	"github.com/riclolsen/go-iecp5/asdu"
)

func TestMapAsduToBaseType(t *testing.T) {
	cases := map[asdu.TypeID]int{
		asdu.M_SP_NA_1: 1, asdu.M_SP_TB_1: 1,
		asdu.M_DP_NA_1: 3, asdu.M_DP_TB_1: 3,
		asdu.M_ST_NA_1: 5, asdu.M_ST_TB_1: 5,
		asdu.M_BO_NA_1: 7, asdu.M_BO_TB_1: 7,
		asdu.M_ME_NA_1: 9, asdu.M_ME_ND_1: 9, asdu.M_ME_TD_1: 9,
		asdu.M_ME_NB_1: 11, asdu.M_ME_TE_1: 11,
		asdu.M_ME_NC_1: 13, asdu.M_ME_TF_1: 13,
		asdu.M_IT_NA_1: 15, asdu.M_IT_TB_1: 15,
	}
	for in, want := range cases {
		if got := MapAsduToBaseType(in); got != want {
			t.Errorf("MapAsduToBaseType(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestBuildInfoObjCP56Upgrade(t *testing.T) {
	tt := time.Now()
	obj := BuildInfoObj(1, 100, 1, false, 0, Quality{}, &tt, 1, 0, false)
	if obj == nil || obj.TypeID != asdu.M_SP_TB_1 {
		t.Fatalf("expected upgrade to M_SP_TB_1, got %v", obj)
	}
	// without a timestamp, the base type is kept
	obj = BuildInfoObj(1, 100, 1, false, 0, Quality{}, nil, 1, 0, false)
	if obj == nil || obj.TypeID != asdu.M_SP_NA_1 {
		t.Fatalf("expected M_SP_NA_1, got %v", obj)
	}
}

func TestBuildInfoObjInversion(t *testing.T) {
	// single point with kconv1 == -1 inverts the boolean
	obj := BuildInfoObj(1, 1, 1, false, 0, Quality{}, nil, -1, 0, false)
	sp := obj.Info.(asdu.SinglePointInfo)
	if sp.Value != false {
		t.Errorf("expected inverted false, got %v", sp.Value)
	}
	// double command with kconv1 == -1 inverts ON<->OFF
	obj = BuildInfoObj(46, 1, 1, false, 0, Quality{}, nil, -1, 0, false)
	dc := obj.Info.(asdu.DoubleCommandInfo)
	if dc.Value != asdu.DCOOff {
		t.Errorf("expected inverted DCOOff, got %v", dc.Value)
	}
}

func TestBuildInfoObjClampOverflow(t *testing.T) {
	// scaled value beyond +32767 clamps and flags overflow
	q := Quality{}
	obj := BuildInfoObj(11, 1, 40000, false, 0, q, nil, 1, 0, false)
	sc := obj.Info.(asdu.MeasuredValueScaledInfo)
	if sc.Value != 32767 {
		t.Errorf("expected clamp to 32767, got %d", sc.Value)
	}
	if sc.Qds&asdu.QDSOverflow == 0 {
		t.Errorf("expected overflow flag set")
	}
}

func TestBuildInfoObjUnsupported(t *testing.T) {
	if obj := BuildInfoObj(15, 1, 1, false, 0, Quality{}, nil, 1, 0, false); obj != nil {
		t.Errorf("expected nil for M_IT_NA_1 destination, got %v", obj)
	}
}

func TestQualityRoundTrip(t *testing.T) {
	q := Quality{Invalid: true, Overflow: true, Substituted: true}
	got := QualityFromQds(q.ToQds())
	if got != q {
		t.Errorf("quality round trip mismatch: %+v != %+v", got, q)
	}
}
