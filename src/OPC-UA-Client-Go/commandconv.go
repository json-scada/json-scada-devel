/*
 * OPC-UA Client Protocol driver for {json:scada}, in Go.
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, version 3.
 *
 * This program is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

// Checked numeric conversion for commands.
//
// A command carries its value as a float64 (a BSON double). Converting that
// to a narrower OPC UA type with a plain Go cast does not fail when the value
// does not fit: it wraps or saturates, so 300 written to a Byte tag arrives
// as 44. These helpers refuse such a value instead, which the caller turns
// into cancelReason "type conversion error" — what the .NET driver does with
// Convert.ToByte(300), which throws.
//
// The rules below were measured against .NET 8, not assumed; see
// testdata/csharp_convert.golden and TestScalarConversionMatchesDotNet.

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/gopcua/opcua/ua"
)

// Limits of a .NET DateTime expressed as Unix milliseconds
// (DateTimeOffset.FromUnixTimeMilliseconds accepts exactly this range).
const (
	minUnixMilli = -62135596800000
	maxUnixMilli = 253402300799999
)

// roundChecked rounds like .NET's Convert.ToXxx(double) — half to even, so
// 2.5 becomes 2 and 3.5 becomes 4 — and then requires the result to lie in
// [lo, hiExcl). NaN and the infinities never fit.
//
// The upper bound is exclusive because 2^63 and 2^64 are exactly
// representable as float64 while 2^63-1 and 2^64-1 are not.
func roundChecked(v, lo, hiExcl float64, typ string) (float64, error) {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0, fmt.Errorf("%v cannot be written as %s", v, typ)
	}
	r := math.RoundToEven(v)
	if r < lo || r >= hiExcl {
		return 0, fmt.Errorf("%v is out of range for %s", v, typ)
	}
	return r, nil
}

// toInteger converts a command value to an integer type of the given range.
func toInteger[T int8 | uint8 | int16 | uint16 | int32 | uint32 | int64 | uint64](v float64, typ string, lo, hiExcl float64) (T, error) {
	r, err := roundChecked(v, lo, hiExcl, typ)
	if err != nil {
		return 0, err
	}
	return T(r), nil
}

// toFloat32 converts to a Float.
//
// deviation D21: a finite value too large for a Float is refused. The .NET
// driver's Convert.ToSingle turns it into Infinity and writes that. NaN and
// the infinities themselves, which a double can hold, are passed through as
// the .NET driver does.
func toFloat32(v float64) (float32, error) {
	f := float32(v)
	if math.IsInf(float64(f), 0) && !math.IsInf(v, 0) {
		return 0, fmt.Errorf("%v is out of range for Float", v)
	}
	return f, nil
}

// toDateTime converts Unix milliseconds to a DateTime, refusing anything a
// .NET DateTime cannot hold.
func toDateTime(v float64) (time.Time, error) {
	r, err := roundChecked(v, math.MinInt64, math.MaxInt64, "DateTime")
	if err != nil {
		return time.Time{}, err
	}
	ms := int64(r)
	if ms < minUnixMilli || ms > maxUnixMilli {
		return time.Time{}, fmt.Errorf("%v is out of range for DateTime", v)
	}
	return time.UnixMilli(ms).UTC(), nil
}

// variantOf builds the variant of a converted value, passing a conversion
// error straight through so a call can wrap the converter directly:
// variantOf(toInteger[int8](...)).
func variantOf(x any, err error) (*ua.Variant, error) {
	if err != nil {
		return nil, err
	}
	return ua.NewVariant(x)
}

// decodeJSONArray parses valueString as a JSON array, keeping numbers as
// their source text so that 64-bit integers survive exactly. ok is false
// when it is not valid JSON, or not an array.
func decodeJSONArray(valueString string) (raw []any, ok bool) {
	dec := json.NewDecoder(strings.NewReader(valueString))
	dec.UseNumber()
	if err := dec.Decode(&raw); err != nil {
		return nil, false
	}
	// Decode stops after the first value; anything after it is malformed.
	if _, err := dec.Token(); err != io.EOF {
		return nil, false
	}
	// The JSON value null decodes into a nil slice without an error, and
	// would otherwise be written to the server as an empty array. [] decodes
	// to a non-nil empty slice, so the two stay distinguishable.
	if raw == nil {
		return nil, false
	}
	return raw, true
}

// jsonNumber returns the source text of a JSON number element.
func jsonNumber(el any, i int) (string, error) {
	n, ok := el.(json.Number)
	if !ok {
		return "", fmt.Errorf("element %d of the array is %T, not a number", i, el)
	}
	return string(n), nil
}

// signedArray converts JSON integer elements to a signed integer type.
//
// An element must be written as a plain integer: 2.0 and 1e2 are refused,
// and so is anything outside the type's range. There is no rounding. That is
// what System.Text.Json's GetValue<short>() and friends do in the .NET
// driver, measured rather than assumed.
func signedArray[T int16 | int32 | int64](raw []any, bits int, typ string) ([]T, error) {
	out := make([]T, len(raw))
	for i, el := range raw {
		s, err := jsonNumber(el, i)
		if err != nil {
			return nil, err
		}
		n, err := strconv.ParseInt(s, 10, bits)
		if err != nil {
			return nil, fmt.Errorf("element %d of the array (%s) is not a valid %s", i, s, typ)
		}
		out[i] = T(n)
	}
	return out, nil
}

// unsignedArray is signedArray for the unsigned integer types.
func unsignedArray[T uint16 | uint32 | uint64](raw []any, bits int, typ string) ([]T, error) {
	out := make([]T, len(raw))
	for i, el := range raw {
		s, err := jsonNumber(el, i)
		if err != nil {
			return nil, err
		}
		n, err := strconv.ParseUint(s, 10, bits)
		if err != nil {
			return nil, fmt.Errorf("element %d of the array (%s) is not a valid %s", i, s, typ)
		}
		out[i] = T(n)
	}
	return out, nil
}

// floatArray converts JSON number elements to a Float or Double.
//
// deviation D21: an element too large for the type is refused. The .NET
// driver turns it into Infinity and writes that.
func floatArray[T float32 | float64](raw []any, bits int, typ string) ([]T, error) {
	out := make([]T, len(raw))
	for i, el := range raw {
		s, err := jsonNumber(el, i)
		if err != nil {
			return nil, err
		}
		f, err := strconv.ParseFloat(s, bits)
		if err != nil {
			return nil, fmt.Errorf("element %d of the array (%s) is out of range for %s", i, s, typ)
		}
		out[i] = T(f)
	}
	return out, nil
}
