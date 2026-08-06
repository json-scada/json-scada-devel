/*
 * IEC 61850 MMS Client driver for {json:scada}, in Go.
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

// Automatic tag creation. Port of TagsCreation.cs: the documents inserted
// here must match what the C# driver inserts, field for field, so that a
// database seeded by one driver works with the other.

package main

import (
	"math"
	"strings"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// TagFromParameters builds the tag name of an automatically created point.
func TagFromParameters(iv IECValue) string {
	return "IEC61850;" + iv.ConnName + ";" + iv.Address + "[" + iv.CommonAddress + "]"
}

// newRealtimeDoc builds the realtimeData document for a discovered point.
func newRealtimeDoc(iv IECValue, id float64) bson.M {
	const group1 = "IEC61850"

	doc := bson.M{
		"_id":                            id,
		"protocolSourceASDU":             iv.Asdu,
		"protocolSourceCommonAddress":    strings.ToUpper(iv.CommonAddress),
		"protocolSourceConnectionNumber": float64(iv.ConnNumber),
		"protocolSourceObjectAddress":    iv.Address,
		"protocolSourceCommandUseSBO":    false,
		"protocolSourceCommandDuration":  0.0,
		"description":                    group1 + "~" + iv.ConnName + "~" + iv.DisplayName,
		"ungroupedDescription":           iv.DisplayName,
		"group1":                         group1,
		"group2":                         iv.ConnName,
		"group3":                         iv.CommonAddress,
		"origin":                         "supervised",
		"tag":                            TagFromParameters(iv),
		"alarmDisabled":                  false,
		"alerted":                        false,
		"alarmed":                        false,
		"alertState":                     "",
		"annotation":                     "",
		"commandBlocked":                 false,
		"commandOfSupervised":            0.0,
		"commissioningRemarks":           "",
		"formula":                        0.0,
		"frozen":                         false,
		"frozenDetectTimeout":            0.0,
		"hiLimit":                        math.MaxFloat64,
		"hihiLimit":                      math.MaxFloat64,
		"hihihiLimit":                    math.MaxFloat64,
		"historianDeadBand":              0.0,
		"historianPeriod":                0.0,
		"hysteresis":                     0.0,
		"invalid":                        true,
		"invalidDetectTimeout":           60000.0,
		"isEvent":                        false,
		"kconv1":                         1.0,
		"kconv2":                         0.0,
		"location":                       nil,
		"loLimit":                        -math.MaxFloat64,
		"loloLimit":                      -math.MaxFloat64,
		"lololoLimit":                    -math.MaxFloat64,
		"notes":                          "",
		"overflow":                       false,
		"parcels":                        nil,
		"priority":                       0.0,
		"protocolDestinations":           nil,
		"sourceDataUpdate":               nil,
		"substituted":                    false,
		"supervisedOfCommand":            0.0,
		"timeTag":                        nil,
		"timeTagAlarm":                   nil,
		"timeTagAtSource":                nil,
		"timeTagAtSourceOk":              false,
		"transient":                      false,
		"unit":                           "",
		"updatesCnt":                     0.0,
		"valueDefault":                   0.0,
		"zeroDeadband":                   0.0,
	}

	switch {
	case strings.EqualFold(iv.Asdu, "boolean") || iv.IsDigital:
		doc["alarmState"] = 2.0
		doc["stateTextFalse"] = "FALSE"
		doc["stateTextTrue"] = "TRUE"
		doc["eventTextFalse"] = "FALSE"
		doc["eventTextTrue"] = "TRUE"
		doc["type"] = "digital"
		doc["value"] = iv.Value
		doc["valueString"] = "????"
	case strings.EqualFold(iv.Asdu, "string") || strings.EqualFold(iv.Asdu, "extensionobject"):
		doc["alarmState"] = -1.0
		doc["stateTextFalse"] = ""
		doc["stateTextTrue"] = ""
		doc["eventTextFalse"] = ""
		doc["eventTextTrue"] = ""
		doc["type"] = "string"
		doc["value"] = 0.0
		doc["valueString"] = iv.ValueString
	default:
		doc["alarmState"] = -1.0
		doc["stateTextFalse"] = ""
		doc["stateTextTrue"] = ""
		doc["eventTextFalse"] = ""
		doc["eventTextTrue"] = ""
		doc["type"] = "analog"
		doc["value"] = iv.Value
		doc["valueString"] = "????"
	}

	return doc
}
