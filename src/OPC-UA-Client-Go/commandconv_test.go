/*
 * OPC-UA Client Protocol driver for {json:scada}, in Go.
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 */

package main

import (
	"bufio"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

// readGolden returns the measurement lines of testdata/csharp_convert.golden.
func readGolden(t *testing.T, prefix string) []string {
	t.Helper()
	f, err := os.Open("testdata/csharp_convert.golden")
	if err != nil {
		t.Fatalf("cannot open the .NET reference: %v", err)
	}
	defer f.Close()

	var out []string
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), prefix+" ") {
			out = append(out, sc.Text())
		}
	}
	if len(out) == 0 {
		t.Fatalf("no %s lines in the .NET reference", prefix)
	}
	return out
}

// Every integer command conversion must agree with what the .NET driver does
// to the same value: either both refuse it, or both write the same number.
// The reference was measured on .NET 8 (testdata/csharp_convert_probe.cs.txt).
func TestScalarConversionMatchesDotNet(t *testing.T) {
	line := regexp.MustCompile(`^SCALAR (\S+) (\S+) -> (.+)$`)
	checked := 0

	for _, l := range readGolden(t, "SCALAR") {
		m := line.FindStringSubmatch(l)
		if m == nil {
			t.Fatalf("unparseable reference line: %q", l)
		}
		asdu, in, want := m[1], m[2], m[3]
		value, err := strconv.ParseFloat(in, 64)
		if err != nil {
			t.Fatalf("bad input in %q: %v", l, err)
		}

		v, reason, gotErr := commandVariant(asdu, value, "")
		if reason != "" {
			t.Fatalf("%s %s: unexpected cancel reason %q", asdu, in, reason)
		}

		dotNetRefuses := strings.HasPrefix(want, "EXC ")
		switch {
		case dotNetRefuses && gotErr == nil:
			t.Errorf("%s %s: .NET refuses (%s) but Go writes %v (%T)", asdu, in, want, v.Value(), v.Value())

		case !dotNetRefuses && gotErr != nil:
			t.Errorf("%s %s: .NET writes %s but Go refuses: %v", asdu, in, want, gotErr)

		case !dotNetRefuses && asdu == "datetime":
			// .NET prints the date in the machine's culture, so compare the
			// instant instead: the input rounded half to even.
			got := v.Value().(time.Time)
			if wantMs := int64(math.RoundToEven(value)); got.UnixMilli() != wantMs {
				t.Errorf("datetime %s: wrote %d ms, want %d", in, got.UnixMilli(), wantMs)
			}

		case !dotNetRefuses:
			wantNum := strings.Fields(want)[0]
			if got := fmt.Sprint(v.Value()); got != wantNum {
				t.Errorf("%s %s: wrote %s, .NET writes %s", asdu, in, got, wantNum)
			}
		}
		checked++
	}
	t.Logf("compared %d scalar conversions with the .NET reference", checked)
}

// Array elements follow different rules from scalars in the .NET driver: no
// rounding, and only plain in-range integers are accepted.
func TestArrayConversionMatchesDotNet(t *testing.T) {
	line := regexp.MustCompile(`^ARRAY elem (.+?) -> (.+)$`)
	column := regexp.MustCompile(`(short|ushort|int|uint|long|ulong):(EXC \w+|-?\d+ ok)`)
	asduOf := map[string]string{
		"short": "int16", "ushort": "uint16", "int": "int32",
		"uint": "uint32", "long": "int64", "ulong": "uint64",
	}
	checked := 0

	for _, l := range readGolden(t, "ARRAY") {
		m := line.FindStringSubmatch(l)
		if m == nil {
			t.Fatalf("unparseable reference line: %q", l)
		}
		elem := m[1]

		for _, c := range column.FindAllStringSubmatch(m[2], -1) {
			asdu, want := asduOf[c[1]], c[2]

			v, reason, err := arrayVariant(asdu+"[]", "["+elem+"]")
			refused := err != nil || reason != ""

			if strings.HasPrefix(want, "EXC ") {
				if !refused {
					t.Errorf("%s[] element %s: .NET refuses (%s) but Go writes %v", asdu, elem, want, v.Value())
				}
			} else {
				if refused {
					t.Errorf("%s[] element %s: .NET writes %s but Go refuses (%q, %v)", asdu, elem, want, reason, err)
					continue
				}
				wantNum := strings.Fields(want)[0]
				if got := fmt.Sprint(v.Value()); got != "["+wantNum+"]" {
					t.Errorf("%s[] element %s: wrote %s, .NET writes [%s]", asdu, elem, got, wantNum)
				}
			}
			checked++
		}
	}
	t.Logf("compared %d array elements with the .NET reference", checked)
}

// The cases that motivated the check, spelled out so a failure reads well.
func TestCommandsAreRefusedWhenOutOfRange(t *testing.T) {
	refused := []struct {
		asdu  string
		value float64
	}{
		{"byte", 300}, {"byte", -1}, {"byte", 255.5},
		{"sbyte", 200}, {"sbyte", -129},
		{"int16", 40000}, {"uint16", -5}, {"uint16", 65536},
		{"int32", 3e9}, {"int32", 2147483647.5}, {"uint32", -1}, {"uint32", 4294967296},
		{"int64", 1e30}, {"int64", 9223372036854775808}, {"uint64", -1}, {"uint64", 1.8446744073709552e19},
		{"int32", math.NaN()}, {"int32", math.Inf(1)}, {"byte", math.Inf(-1)},
		{"datetime", 253402300800000}, {"datetime", -62135596800001}, {"datetime", math.NaN()},
		// A finite value too large for a Float must not turn into +Inf.
		{"float", 1e300}, {"float", -1e300},
	}
	for _, c := range refused {
		if v, _, err := commandVariant(c.asdu, c.value, ""); err == nil {
			t.Errorf("%s %v must be refused, but would write %v (%T)", c.asdu, c.value, v.Value(), v.Value())
		}
	}
}

// Rounding is half to even, like .NET's Convert, not truncation.
func TestCommandsRoundHalfToEven(t *testing.T) {
	cases := []struct {
		asdu  string
		value float64
		want  string
	}{
		{"int32", 2.5, "2"}, {"int32", 3.5, "4"}, {"int32", -2.5, "-2"}, {"int32", -3.5, "-4"},
		{"int32", 2.4999, "2"}, {"int32", 2.5001, "3"},
		// A tiny negative rounds to zero rather than wrapping an unsigned type.
		{"byte", -0.4, "0"}, {"uint32", -0.4, "0"}, {"uint64", -0.4, "0"},
		{"byte", 254.5, "254"}, {"byte", 255.4, "255"},
		{"int32", -2147483648.5, "-2147483648"},
	}
	for _, c := range cases {
		v, _, err := commandVariant(c.asdu, c.value, "")
		if err != nil {
			t.Errorf("%s %v: unexpected error %v", c.asdu, c.value, err)
			continue
		}
		if got := fmt.Sprint(v.Value()); got != c.want {
			t.Errorf("%s %v: wrote %s, want %s", c.asdu, c.value, got, c.want)
		}
	}
}

// The extremes of every integer type are valid, and exact.
func TestCommandsAcceptTheExtremes(t *testing.T) {
	cases := []struct {
		asdu  string
		value float64
		want  string
	}{
		{"sbyte", -128, "-128"}, {"sbyte", 127, "127"},
		{"byte", 0, "0"}, {"byte", 255, "255"},
		{"int16", -32768, "-32768"}, {"int16", 32767, "32767"},
		{"uint16", 65535, "65535"},
		{"int32", -2147483648, "-2147483648"}, {"int32", 2147483647, "2147483647"},
		{"uint32", 4294967295, "4294967295"},
		{"int64", -9223372036854775808, "-9223372036854775808"},
		{"uint64", 9.3e18, "9300000000000000000"},
	}
	for _, c := range cases {
		v, _, err := commandVariant(c.asdu, c.value, "")
		if err != nil {
			t.Errorf("%s %v must be accepted: %v", c.asdu, c.value, err)
			continue
		}
		if got := fmt.Sprint(v.Value()); got != c.want {
			t.Errorf("%s %v: wrote %s, want %s", c.asdu, c.value, got, c.want)
		}
	}
}

// NaN and the infinities are legitimate Float and Double values, and the
// .NET driver passes them through, so this does too (deviation D21 only
// concerns a finite value that overflows a Float).
func TestFloatingPointCommandsPassNonFiniteThrough(t *testing.T) {
	for _, asdu := range []string{"float", "double"} {
		for _, v := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
			if _, _, err := commandVariant(asdu, v, ""); err != nil {
				t.Errorf("%s %v must be accepted: %v", asdu, v, err)
			}
		}
	}
	// A Double holds anything a float64 does.
	if _, _, err := commandVariant("double", 1e300, ""); err != nil {
		t.Errorf("double 1e300 must be accepted: %v", err)
	}
}

// 64-bit integers in an array must survive exactly, which a float64 cannot
// provide above 2^53.
func TestArrayKeeps64BitIntegersExact(t *testing.T) {
	v, reason, err := arrayVariant("uint64[]", "[18446744073709551615, 9007199254740993]")
	if reason != "" || err != nil {
		t.Fatalf("reason=%q err=%v", reason, err)
	}
	if got := fmt.Sprint(v.Value()); got != "[18446744073709551615 9007199254740993]" {
		t.Errorf("wrote %s", got)
	}
	v, _, err = arrayVariant("int64[]", "[-9223372036854775808, 9223372036854775807]")
	if err != nil {
		t.Fatalf("int64 extremes refused: %v", err)
	}
	if got := fmt.Sprint(v.Value()); got != "[-9223372036854775808 9223372036854775807]" {
		t.Errorf("wrote %s", got)
	}
}

// deviation D21 for arrays: an element too large for a Float or Double is
// refused where the .NET driver would write Infinity.
func TestArrayFloatOverflowIsRefused(t *testing.T) {
	for _, c := range []struct{ asdu, body string }{
		{"float[]", "[1, 1e40]"}, {"float[]", "[-1e40]"}, {"double[]", "[1e400]"},
	} {
		if v, reason, err := arrayVariant(c.asdu, c.body); err == nil && reason == "" {
			t.Errorf("%s %s must be refused, but would write %v", c.asdu, c.body, v.Value())
		}
	}
	// Values that fit are written, however small.
	if _, reason, err := arrayVariant("float[]", "[3.4e38, 1e-50, 0]"); err != nil || reason != "" {
		t.Errorf("in-range floats refused: reason=%q err=%v", reason, err)
	}
}

// A malformed or trailing-garbage array is refused as invalid JSON.
func TestDecodeJSONArray(t *testing.T) {
	for _, bad := range []string{"nope", `{"a":1}`, "[1,2] trailing", "[1,2", "5", "null", `"x"`} {
		if raw, ok := decodeJSONArray(bad); ok {
			t.Errorf("%q must be refused, got %v", bad, raw)
		}
	}
	for _, good := range []string{"[]", "[1]", " [1, 2.5, \"a\", true, null] ", "[[1],[2]]"} {
		if _, ok := decodeJSONArray(good); !ok {
			t.Errorf("%q must be accepted", good)
		}
	}
}
