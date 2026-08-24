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

// Thin typed accessors over bson.Raw. Change stream events are never fully
// unmarshalled: only the handful of fields the processing needs are looked
// up, which is where a good part of the latency advantage over the Node.js
// implementation comes from (Node builds a complete JS object graph for every
// event, including the full document fetched by updateLookup).

package main

import (
	"math"
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

type rawDoc struct {
	raw bson.Raw
}

func (d rawDoc) valid() bool { return len(d.raw) > 0 }

func (d rawDoc) lookup(key string) bson.RawValue {
	if len(d.raw) == 0 {
		return bson.RawValue{}
	}
	v, err := d.raw.LookupErr(key)
	if err != nil {
		return bson.RawValue{}
	}
	return v
}

// has reports whether the field exists, even when its value is null
// (the JavaScript "key in obj" test).
func (d rawDoc) has(key string) bool {
	return d.lookup(key).Type != 0
}

// isNull reports whether the field exists and holds null.
func (d rawDoc) isNull(key string) bool {
	t := d.lookup(key).Type
	return t == bson.TypeNull
}

// doc returns an embedded document.
func (d rawDoc) doc(key string) rawDoc {
	v := d.lookup(key)
	if v.Type != bson.TypeEmbeddedDocument {
		return rawDoc{}
	}
	sub, ok := v.DocumentOK()
	if !ok {
		return rawDoc{}
	}
	return rawDoc{raw: sub}
}

// str returns a string field, or "" when absent or of another type.
func (d rawDoc) str(key string) string {
	v := d.lookup(key)
	s, ok := v.StringValueOK()
	if !ok {
		return ""
	}
	return s
}

// num returns a numeric field (double, int32, int64) and whether it was
// present as a number.
func (d rawDoc) num(key string) (float64, bool) {
	return rawValueNum(d.lookup(key))
}

func rawValueNum(v bson.RawValue) (float64, bool) {
	switch v.Type {
	case bson.TypeDouble:
		return v.Double(), true
	case bson.TypeInt32:
		return float64(v.Int32()), true
	case bson.TypeInt64:
		return float64(v.Int64()), true
	case bson.TypeDecimal128:
		f, err := strconv.ParseFloat(v.Decimal128().String(), 64)
		if err != nil {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}

func (d rawDoc) numOr(key string, def float64) float64 {
	if v, ok := d.num(key); ok {
		return v
	}
	return def
}

// boolStrict returns the value only when the field is really a BSON boolean,
// reproducing the "typeof x === 'boolean'" tests of the Node.js version.
func (d rawDoc) boolStrict(key string) (bool, bool) {
	v := d.lookup(key)
	if v.Type != bson.TypeBoolean {
		return false, false
	}
	return v.Boolean(), true
}

// truthy reproduces the JavaScript truthiness of a field value.
func (d rawDoc) truthy(key string) bool {
	v := d.lookup(key)
	switch v.Type {
	case 0, bson.TypeNull, bson.TypeUndefined:
		return false
	case bson.TypeBoolean:
		return v.Boolean()
	case bson.TypeString:
		s, _ := v.StringValueOK()
		return s != ""
	case bson.TypeDouble, bson.TypeInt32, bson.TypeInt64:
		n, _ := rawValueNum(v)
		return n != 0 && !math.IsNaN(n)
	default:
		return true
	}
}

func (d rawDoc) boolOr(key string, def bool) bool {
	if b, ok := d.boolStrict(key); ok {
		return b
	}
	return def
}

// timeOf returns a date field.
func (d rawDoc) timeOf(key string) (time.Time, bool) {
	v := d.lookup(key)
	if v.Type != bson.TypeDateTime {
		return time.Time{}, false
	}
	return v.Time(), true
}

// rawOrNil turns an absent lookup into a BSON null, so a raw value can be
// forwarded straight into a document without a marshalling error.
func rawOrNil(v bson.RawValue) any {
	if v.Type == 0 {
		return nil
	}
	return v
}

// jsBSONNumber reproduces how the Node.js BSON serializer encodes a plain
// JavaScript number: integers that fit in 32 bits become int32, everything
// else becomes a double. Fields the Node.js code wraps in Double() are
// written as float64 instead and must not go through here.
func jsBSONNumber(v float64) any {
	if v == math.Trunc(v) && !math.IsInf(v, 0) && v >= math.MinInt32 && v <= math.MaxInt32 {
		return int32(v)
	}
	return v
}

// idValue returns the raw _id so filters keep the exact BSON type the point
// was created with (the point keys are doubles in {json:scada}).
func (d rawDoc) idValue() bson.RawValue {
	return d.lookup("_id")
}

// idString renders the _id for log messages.
func (d rawDoc) idString() string {
	v := d.lookup("_id")
	if n, ok := rawValueNum(v); ok {
		return jsNumberToString(n)
	}
	if v.Type == bson.TypeObjectID {
		return v.ObjectID().Hex()
	}
	if s, ok := v.StringValueOK(); ok {
		return s
	}
	return ""
}
