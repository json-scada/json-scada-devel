/*
 * IEC 60870-5-101/104 protocol drivers for {json:scada} - permissive uint32
 * {json:scada} - Copyright (c) 2020 - 2026 - Ricardo L. Olsen
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

package model

import (
	"math"
	"strconv"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// U32 is an address-like protocol field (ASDU type, common address, object
// address) decoded permissively from BSON: string, double, int32, int64,
// decimal128 and boolean all convert to uint32. Values that cannot be parsed,
// as well as null/missing fields, decode as 0 (the drivers reject 0 where it
// is not a valid address). Out-of-range values are clamped to [0, 2^32-1].
type U32 uint32

// compile-time checks of the BSON value interfaces
var (
	_ bson.ValueUnmarshaler = (*U32)(nil)
	_ bson.ValueMarshaler   = U32(0)
)

// ParseU32 converts a string to U32 permissively, accepting decimal integers,
// floating-point representations ("1001.0") and surrounding whitespace.
func ParseU32(s string) U32 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if u, err := strconv.ParseUint(s, 10, 64); err == nil {
		return U32FromFloat(float64(u))
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return U32FromFloat(f)
	}
	return 0
}

// U32FromFloat truncates a number to U32, clamping to [0, 2^32-1].
func U32FromFloat(f float64) U32 {
	if math.IsNaN(f) || f <= 0 {
		return 0
	}
	if f >= math.MaxUint32 {
		return math.MaxUint32
	}
	return U32(f)
}

// UnmarshalBSONValue decodes any BSON representation of the field to uint32.
func (u *U32) UnmarshalBSONValue(typ byte, data []byte) error {
	rv := bson.RawValue{Type: bson.Type(typ), Value: data}
	switch rv.Type {
	case bson.TypeNull, bson.TypeUndefined:
		*u = 0
	case bson.TypeString:
		*u = ParseU32(rv.StringValue())
	case bson.TypeBoolean:
		*u = 0
		if rv.Boolean() {
			*u = 1
		}
	case bson.TypeDecimal128:
		*u = ParseU32(rv.Decimal128().String())
	default:
		f, ok := rv.AsFloat64OK()
		if !ok {
			*u = 0
			return nil // permissive: unexpected types decode as 0
		}
		*u = U32FromFloat(f)
	}
	return nil
}

// MarshalBSONValue encodes the field as a BSON double, the representation
// used by the other {json:scada} drivers.
func (u U32) MarshalBSONValue() (byte, []byte, error) {
	typ, data, err := bson.MarshalValue(float64(u))
	return byte(typ), data, err
}
