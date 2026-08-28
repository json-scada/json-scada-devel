/*
 * IEC 60870-5-103 client driver for {json:scada} - conversions
 * {json:scada} - Copyright (c) 2020 - 2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * Decodes IEC 60870-5-103 (protection equipment) monitor ASDUs into the
 * shared IecValue model and builds general commands. There is no C# driver
 * to match — the addressing convention is defined here:
 *
 *   protocolSourceCommonAddress  = device common address (ASDU CommonAddr)
 *   protocolSourceObjectAddress  = FUN*65536 + INF*256 + measurand index
 *   protocolSourceASDU           = 103 type identification number
 *
 * TimeTagged ASDUs (1/2) carry a single digital state (DPI); Measurands
 * ASDUs (3/9) carry several analog values, one per index. Command
 * acknowledgements arrive as ASDU 1 with cause 20 (positive) / 21 (negative).
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

package conv103

import (
	"fmt"
	"time"

	"github.com/riclolsen/go-iecp5/asdu"
	"github.com/riclolsen/go-iecp5/cs103"

	"iec60870-5/internal/conv"
)

// Addr encodes a (FUN, INF, index) triple into a single object address.
func Addr(fun, inf, idx int) int {
	return fun<<16 | inf<<8 | idx
}

// SplitAddr decodes an object address into (FUN, INF, index).
func SplitAddr(addr int) (fun, inf, idx int) {
	return (addr >> 16) & 0xFF, (addr >> 8) & 0xFF, addr & 0xFF
}

// DecodeResult carries what was extracted from one received 103 ASDU.
type DecodeResult struct {
	Values []conv.IecValue
	Acks   []conv.IecCmdAck
}

// Decode converts a received 103 ASDU into acquired values and/or command
// acknowledgements.
func Decode(a *cs103.ASDU, connNumber int) DecodeResult {
	var res DecodeResult
	now := time.Now()
	ca := int(a.CommonAddr)

	switch a.Type {
	case cs103.TypTimeTagged, cs103.TypTimeTaggedRel: // ASDU 1, 2
		info, err := a.GetTimeTagged()
		if err != nil {
			return res
		}
		addr := Addr(int(info.Fun), int(info.Inf), 0)
		// command acknowledgement (cause 20 positive / 21 negative)
		if a.Coa == cs103.CauseCommandAckPos || a.Coa == cs103.CauseCommandAckNeg {
			res.Acks = append(res.Acks, conv.IecCmdAck{
				Ack:           a.Coa == cs103.CauseCommandAckPos,
				ConnNumber:    connNumber,
				ObjectAddress: addr,
				AckTimeTag:    now,
			})
			return res
		}
		// data point: DPI On=1, Off=0; transient/unknown -> invalid
		value := 0.0
		q := conv.Quality{}
		switch info.Dpi {
		case cs103.DPIOn:
			value = 1
		case cs103.DPIOff:
			value = 0
		default:
			q.Invalid = true
		}
		iv := conv.IecValue{
			Address:         addr,
			Asdu:            asdu.M_SP_NA_1, // digital, for autoCreateTags mapping
			AsduStr:         a.Type.String(),
			IsDigital:       true,
			Value:           value,
			Cot:             int(a.Coa),
			ServerTimestamp: now,
			Quality:         q,
			ConnNumber:      connNumber,
			CommonAddress:   ca,
		}
		if !info.Time.IsZero() {
			iv.HasSourceTimestamp = true
			iv.SourceTimestamp = info.Time
			iv.TimestampOk = true
		}
		res.Values = append(res.Values, iv)

	case cs103.TypMeasurandsI, cs103.TypMeasurandsII: // ASDU 3, 9
		info, err := a.GetMeasurands()
		if err != nil {
			return res
		}
		for i, m := range info.Values {
			q := conv.Quality{Invalid: m.Invalid, Overflow: m.Overflow}
			res.Values = append(res.Values, conv.IecValue{
				Address:         Addr(int(info.Fun), int(info.Inf), i),
				Asdu:            asdu.M_ME_NC_1, // analog, for autoCreateTags mapping
				AsduStr:         a.Type.String(),
				IsDigital:       false,
				Value:           m.Float64(),
				Cot:             int(a.Coa),
				ServerTimestamp: now,
				Quality:         q,
				ConnNumber:      connNumber,
				CommonAddress:   ca,
			})
		}
	}
	return res
}

// GeneralCommandParams decodes an object address to the FUN/INF plus the
// DCO derived from the command value (non-zero = On).
func GeneralCommandParams(objAddr int, value float64) (fun, inf byte, dco cs103.DCO) {
	f, i, _ := SplitAddr(objAddr)
	dco = cs103.DCOOff
	if value != 0 {
		dco = cs103.DCOOn
	}
	return byte(f), byte(i), dco
}

// TypeDescription returns a human description for a 103 type identification.
func TypeDescription(t cs103.TypeID) string {
	switch t {
	case cs103.TypTimeTagged, cs103.TypTimeTaggedRel:
		return "Time-Tagged"
	case cs103.TypMeasurandsI:
		return "Measurands I"
	case cs103.TypMeasurandsII:
		return "Measurands II"
	default:
		return fmt.Sprintf("ASDU %d", int(t))
	}
}
