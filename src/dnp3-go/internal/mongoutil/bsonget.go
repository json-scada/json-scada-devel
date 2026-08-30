/*
 * DNP3 Client and Server Protocol drivers for {json:scada}, in Go.
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

// Permissive accessors for bson.M documents. Ports of getDouble, getBoolean,
// getString and getDate of the C++ drivers, which accept any numeric BSON type
// where a number is wanted because the collections hold a mixture of int32,
// int64 and double written by different drivers over the years.

package mongoutil

import (
	"strconv"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// GetDouble reads a numeric field, accepting int32, int64, double and bool.
func GetDouble(doc bson.M, key string, def float64) float64 {
	v, ok := doc[key]
	if !ok || v == nil {
		return def
	}
	return toFloat(v, def)
}

func toFloat(v any, def float64) float64 {
	switch x := v.(type) {
	case float64:
		return x
	case float32:
		return float64(x)
	case int32:
		return float64(x)
	case int64:
		return float64(x)
	case int:
		return float64(x)
	case bool:
		if x {
			return 1
		}
		return 0
	default:
		return def
	}
}

// GetInt is GetDouble truncated, which is how every numeric configuration
// field of the C++ drivers is read.
func GetInt(doc bson.M, key string, def int) int {
	return int(GetDouble(doc, key, float64(def)))
}

// GetBool reads a boolean field, accepting a number as well.
func GetBool(doc bson.M, key string, def bool) bool {
	v, ok := doc[key]
	if !ok || v == nil {
		return def
	}
	if b, ok := v.(bool); ok {
		return b
	}
	d := float64(0)
	if def {
		d = 1
	}
	return toFloat(v, d) != 0
}

// GetString reads a string field. Unlike the C++ server's getString it does not
// render numbers, because every caller that wanted that was logging an _id and
// got an empty string instead; those call sites format the number themselves.
func GetString(doc bson.M, key string, def string) string {
	v, ok := doc[key]
	if !ok || v == nil {
		return def
	}
	if s, ok := v.(string); ok {
		return s
	}
	return def
}

// GetDateMs reads a date field as milliseconds since the epoch, accepting an
// integer as well.
func GetDateMs(doc bson.M, key string, def int64) int64 {
	v, ok := doc[key]
	if !ok || v == nil {
		return def
	}
	switch x := v.(type) {
	case bson.DateTime:
		return int64(x)
	case time.Time:
		return x.UnixMilli()
	case int64:
		return x
	case int32:
		return int64(x)
	case float64:
		return int64(x)
	default:
		return def
	}
}

// GetStringArray reads an array field, keeping only its string elements.
func GetStringArray(doc bson.M, key string) []string {
	v, ok := doc[key]
	if !ok || v == nil {
		return nil
	}
	arr, ok := v.(bson.A)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, el := range arr {
		if s, ok := el.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// GetDocArray reads an array of sub-documents, which is how rangeScans and
// protocolDestinations are stored.
func GetDocArray(doc bson.M, key string) []bson.M {
	v, ok := doc[key]
	if !ok || v == nil {
		return nil
	}
	arr, ok := v.(bson.A)
	if !ok {
		return nil
	}
	out := make([]bson.M, 0, len(arr))
	for _, el := range arr {
		switch d := el.(type) {
		case bson.M:
			out = append(out, d)
		case bson.D:
			m := make(bson.M, len(d))
			for _, e := range d {
				m[e.Key] = e.Value
			}
			out = append(out, m)
		}
	}
	return out
}

// FormatID renders a tag _id for a log line. The ids are doubles holding whole
// numbers, so they read better without an exponent or a trailing ".000000".
func FormatID(id float64) string {
	return strconv.FormatFloat(id, 'f', -1, 64)
}
