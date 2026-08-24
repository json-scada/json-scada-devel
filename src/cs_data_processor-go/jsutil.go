/*
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

// JavaScript compatible primitives.
//
// The values written by this process end up in strings that the rest of
// {json:scada} already consumes (valueString shown on the HMI, the JSON blob
// stored in PostgreSQL realtime_data), so numbers and JSON documents have to
// be rendered exactly the way Node.js renders them.

package main

import (
	"encoding/base64"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// jsNumberToString implements ECMA-262 Number::toString(10), which is what
// string concatenation with a number does in JavaScript.
func jsNumberToString(v float64) string {
	if math.IsNaN(v) {
		return "NaN"
	}
	if v == 0 {
		return "0" // JavaScript renders -0 as "0"
	}
	if math.IsInf(v, 1) {
		return "Infinity"
	}
	if math.IsInf(v, -1) {
		return "-Infinity"
	}
	sign := ""
	if v < 0 {
		sign = "-"
		v = -v
	}

	// Shortest round trip digits and decimal exponent.
	e := strconv.FormatFloat(v, 'e', -1, 64) // d.dddde±dd
	epos := strings.IndexByte(e, 'e')
	mant := e[:epos]
	exp10, _ := strconv.Atoi(e[epos+1:])
	digits := strings.Replace(mant, ".", "", 1)
	k := len(digits)
	n := exp10 + 1 // position of the decimal point within digits

	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	// exponential notation
	expPart := n - 1
	expSign := "+"
	if expPart < 0 {
		expSign = "-"
		expPart = -expPart
	}
	if k == 1 {
		return sign + digits + "e" + expSign + strconv.Itoa(expPart)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + expSign + strconv.Itoa(expPart)
}

// jsParseFloatToFixed reproduces parseFloat(value.toFixed(digits)), used to
// trim the value shown in valueString and in the event texts.
func jsParseFloatToFixed(v float64, digits int) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return v
	}
	if math.Abs(v) >= 1e21 {
		return v
	}
	r, err := strconv.ParseFloat(strconv.FormatFloat(v, 'f', digits, 64), 64)
	if err != nil {
		return v
	}
	return r
}

// jsFixedString is the common idiom "" + parseFloat(v.toFixed(digits)).
func jsFixedString(v float64, digits int) string {
	return jsNumberToString(jsParseFloatToFixed(v, digits))
}

// jsToStringRadix2 implements Number.prototype.toString(2), used to render
// bitstring (M_BO_*) values.
func jsToStringRadix2(v float64) string {
	if math.IsNaN(v) {
		return "NaN"
	}
	if math.IsInf(v, 1) {
		return "Infinity"
	}
	if math.IsInf(v, -1) {
		return "-Infinity"
	}
	sign := ""
	if math.Signbit(v) && v != 0 {
		sign = "-"
		v = -v
	}
	ip := math.Trunc(v)
	frac := v - ip

	var intPart string
	if ip < 9.007199254740992e15 { // below 2^53 an int64 is exact
		intPart = strconv.FormatInt(int64(ip), 2)
	} else {
		// Large magnitudes: build the digits from the IEEE-754 fields.
		bits := math.Float64bits(ip)
		mantissa := bits&((1<<52)-1) | (1 << 52)
		exp := int((bits>>52)&0x7ff) - 1023 - 52
		s := strconv.FormatUint(mantissa, 2)
		if exp > 0 {
			s += strings.Repeat("0", exp)
		}
		intPart = s
	}
	if frac == 0 {
		return sign + intPart
	}
	var b strings.Builder
	b.WriteString(sign)
	b.WriteString(intPart)
	b.WriteByte('.')
	for i := 0; i < 1075 && frac > 0; i++ {
		frac *= 2
		if frac >= 1 {
			b.WriteByte('1')
			frac--
		} else {
			b.WriteByte('0')
		}
	}
	return b.String()
}

// jsIsNaNString reproduces isNaN(str): the string is coerced to a number
// first, so "" and whitespace are 0 (not NaN) and "0x1f" is 31.
func jsIsNaNString(s string) bool {
	t := strings.TrimSpace(s)
	if t == "" {
		return false
	}
	switch t {
	case "Infinity", "+Infinity", "-Infinity":
		return false
	}
	if len(t) > 2 {
		switch strings.ToLower(t[:2]) {
		case "0x":
			_, err := strconv.ParseUint(t[2:], 16, 64)
			return err != nil
		case "0o":
			_, err := strconv.ParseUint(t[2:], 8, 64)
			return err != nil
		case "0b":
			_, err := strconv.ParseUint(t[2:], 2, 64)
			return err != nil
		}
	}
	_, err := strconv.ParseFloat(t, 64)
	return err != nil
}

// jsISODate reproduces Date.prototype.toISOString().
func jsISODate(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// ---------------------------------------------------------------------------
// JSON.stringify over a BSON document
// ---------------------------------------------------------------------------

// jsonValue is an already rendered JSON fragment used to override a field of
// the source document without losing the original field order.
type jsonValue struct {
	raw string
}

func jvNumber(v float64) jsonValue { return jsonValue{raw: jsJSONNumber(v)} }
func jvString(s string) jsonValue  { return jsonValue{raw: jsJSONString(s)} }
func jvBool(b bool) jsonValue {
	if b {
		return jsonValue{raw: "true"}
	}
	return jsonValue{raw: "false"}
}
func jvNull() jsonValue { return jsonValue{raw: "null"} }
func jvDate(t time.Time) jsonValue {
	return jsonValue{raw: jsJSONString(jsISODate(t))}
}

// jsJSONNumber renders a number the way JSON.stringify does (non finite
// numbers become null).
func jsJSONNumber(v float64) string {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return "null"
	}
	return jsNumberToString(v)
}

// jsJSONString escapes a string exactly like JSON.stringify: only the
// mandatory escapes, non ASCII characters are emitted verbatim.
func jsJSONString(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 2)
	b.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch c {
			case '"':
				b.WriteString("\\\"")
			case '\\':
				b.WriteString("\\\\")
			case '\b':
				b.WriteString("\\b")
			case '\f':
				b.WriteString("\\f")
			case '\n':
				b.WriteString("\\n")
			case '\r':
				b.WriteString("\\r")
			case '\t':
				b.WriteString("\\t")
			default:
				if c < 0x20 {
					const hex = "0123456789abcdef"
					b.WriteString("\\u00")
					b.WriteByte(hex[c>>4])
					b.WriteByte(hex[c&0xf])
				} else {
					b.WriteByte(c)
				}
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b.WriteString("\\ufffd")
		} else {
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	b.WriteByte('"')
	return b.String()
}

// bsonDocToJSON renders a BSON document as JSON with the field order of the
// document preserved, which is what JSON.stringify(fullDocument) produces in
// the Node.js implementation.
//
// overrides replaces the value of the named fields in place; overrideOrder
// lists the fields that must be appended (in that order) when they are not
// already present, matching a JavaScript property assignment on a missing key.
func bsonDocToJSON(doc bson.Raw, overrides map[string]jsonValue, overrideOrder []string) string {
	var b strings.Builder
	b.Grow(len(doc) * 2)
	written := make(map[string]bool, len(overrides))
	b.WriteByte('{')
	first := true
	elems, err := doc.Elements()
	if err == nil {
		for _, el := range elems {
			key := el.Key()
			if !first {
				b.WriteByte(',')
			}
			first = false
			b.WriteString(jsJSONString(key))
			b.WriteByte(':')
			if ov, ok := overrides[key]; ok {
				b.WriteString(ov.raw)
				written[key] = true
			} else {
				b.WriteString(bsonValueToJSON(el.Value()))
			}
		}
	}
	for _, key := range overrideOrder {
		if written[key] {
			continue
		}
		ov, ok := overrides[key]
		if !ok {
			continue
		}
		if !first {
			b.WriteByte(',')
		}
		first = false
		b.WriteString(jsJSONString(key))
		b.WriteByte(':')
		b.WriteString(ov.raw)
	}
	b.WriteByte('}')
	return b.String()
}

// bsonValueToJSON renders a single BSON value the way the Node.js MongoDB
// driver's objects serialize through JSON.stringify.
func bsonValueToJSON(v bson.RawValue) string {
	switch v.Type {
	case bson.TypeDouble:
		return jsJSONNumber(v.Double())
	case bson.TypeInt32:
		return strconv.FormatInt(int64(v.Int32()), 10)
	case bson.TypeInt64:
		return strconv.FormatInt(v.Int64(), 10)
	case bson.TypeString:
		s, _ := v.StringValueOK()
		return jsJSONString(s)
	case bson.TypeBoolean:
		if v.Boolean() {
			return "true"
		}
		return "false"
	case bson.TypeNull, bson.TypeUndefined, bson.TypeMinKey, bson.TypeMaxKey:
		return "null"
	case bson.TypeDateTime:
		return jsJSONString(jsISODate(v.Time()))
	case bson.TypeObjectID:
		return jsJSONString(v.ObjectID().Hex())
	case bson.TypeEmbeddedDocument:
		d, ok := v.DocumentOK()
		if !ok {
			return "null"
		}
		return bsonDocToJSON(d, nil, nil)
	case bson.TypeArray:
		arr, ok := v.ArrayOK()
		if !ok {
			return "null"
		}
		vals, err := arr.Values()
		if err != nil {
			return "null"
		}
		var b strings.Builder
		b.WriteByte('[')
		for i, item := range vals {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(bsonValueToJSON(item))
		}
		b.WriteByte(']')
		return b.String()
	case bson.TypeDecimal128:
		d := v.Decimal128()
		return `{"$numberDecimal":` + jsJSONString(d.String()) + `}`
	case bson.TypeBinary:
		st, data := v.Binary()
		return `{"$binary":{"base64":` + jsJSONString(base64.StdEncoding.EncodeToString(data)) +
			`,"subType":` + jsJSONString(strconv.FormatUint(uint64(st), 16)) + `}}`
	case bson.TypeRegex:
		pattern, _ := v.Regex()
		return jsJSONString(pattern)
	case bson.TypeTimestamp:
		t, i := v.Timestamp()
		return `{"$timestamp":{"t":` + strconv.FormatUint(uint64(t), 10) +
			`,"i":` + strconv.FormatUint(uint64(i), 10) + `}}`
	case bson.TypeJavaScript, bson.TypeSymbol:
		s, _ := v.StringValueOK()
		return jsJSONString(s)
	default:
		return "null"
	}
}

// sqlQuote doubles single quotes for inclusion inside a SQL literal, the same
// replacement the Node.js version does before building its statements.
func sqlQuote(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}
