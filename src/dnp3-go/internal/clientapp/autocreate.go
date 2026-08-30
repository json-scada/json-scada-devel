/*
 * DNP3 Client Protocol driver for {json:scada}, in Go.
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

// Automatic tag creation. Port of autocreate.cpp.

package clientapp

import (
	"context"
	"math"
	"strconv"

	"dnp3-go/internal/dnp3util"
	"dnp3-go/internal/jscfg"
	"dnp3-go/internal/mongoutil"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// nextAutoKey allocates the _id of a new tag.
//
// Each connection owns the range [number*1e6, (number+1)*1e6). The first call
// finds the highest id already used in it and continues from there; later calls
// increment in memory.
func nextAutoKey(ctx context.Context, conn *Connection, rtd *mongo.Collection) float64 {
	if conn.lastNewKeyCreated == 0 {
		base := float64(conn.ProtocolConnectionNumber) * AutoKeyMultiplier
		top := float64(conn.ProtocolConnectionNumber+1) * AutoKeyMultiplier

		var doc bson.M
		err := rtd.FindOne(ctx,
			bson.M{"_id": bson.M{"$gt": base, "$lt": top}},
			options.FindOne().SetSort(bson.M{"_id": -1}),
		).Decode(&doc)
		if err == nil {
			conn.lastNewKeyCreated = mongoutil.GetDouble(doc, "_id", base) + 1
		} else {
			conn.lastNewKeyCreated = base
		}
	} else {
		conn.lastNewKeyCreated++
	}
	return conn.lastNewKeyCreated
}

// newTagDoc builds a realtimeData document for an address seen for the first
// time. Port of newRealtimeTagDoc(); every field is reproduced, because the
// rest of JSON-SCADA reads most of them and a missing one shows up as a blank
// column in a viewer rather than as an error.
func newTagDoc(iv Dnp3Value, connName string, id float64, isCommand bool,
	srcCommonAddress int, asdu, commandDuration, commandOfSupervised, supervisedOfCommand float64) bson.M {

	tagType := dnp3util.TypeFromBaseGroup(srcCommonAddress)
	grpDesc := dnp3util.GroupDescription(srcCommonAddress)
	addrStr := strconv.Itoa(iv.Address)
	tag := connName + ";" + strconv.Itoa(srcCommonAddress) + ";" + addrStr
	desc := connName + "~" + grpDesc + "~" + addrStr
	if isCommand {
		desc += "-Command"
	}
	isDigital := tagType == "digital"

	origin := "supervised"
	if isCommand {
		origin = "command"
	}
	alarmState := -1.0
	stateFalse, stateTrue := "", ""
	if isDigital {
		alarmState = 2.0
		stateFalse, stateTrue = "FALSE", "TRUE"
	}
	value, valueString := iv.Value, iv.ValueString
	if isCommand {
		value, valueString = 0.0, ""
	}

	return bson.M{
		"_id":                            id,
		"tag":                            tag,
		"type":                           tagType,
		"origin":                         origin,
		"description":                    desc,
		"ungroupedDescription":           grpDesc + " " + addrStr,
		"group1":                         connName,
		"group2":                         grpDesc,
		"group3":                         "",
		"protocolSourceConnectionNumber": float64(iv.ConnNumber),
		"protocolSourceCommonAddress":    float64(srcCommonAddress),
		"protocolSourceObjectAddress":    float64(iv.Address),
		"protocolSourceASDU":             asdu,
		"protocolSourceCommandDuration":  commandDuration,
		"protocolSourceCommandUseSBO":    false,
		"commandOfSupervised":            commandOfSupervised,
		"supervisedOfCommand":            supervisedOfCommand,
		"kconv1":                         1.0,
		"kconv2":                         0.0,
		"alarmState":                     alarmState,
		"stateTextFalse":                 stateFalse,
		"stateTextTrue":                  stateTrue,
		"eventTextFalse":                 stateFalse,
		"eventTextTrue":                  stateTrue,
		"value":                          value,
		"valueString":                    valueString,
		"invalid":                        true,
		"invalidDetectTimeout":           60000.0,
		"isEvent":                        false,
		"alarmDisabled":                  false,
		"alarmed":                        false,
		"alerted":                        false,
		"alertState":                     "",
		"annotation":                     "",
		"commandBlocked":                 false,
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
		"loLimit":                        -math.MaxFloat64,
		"loloLimit":                      -math.MaxFloat64,
		"lololoLimit":                    -math.MaxFloat64,
		"location":                       nil,
		"notes":                          "",
		"overflow":                       false,
		"parcels":                        nil,
		"priority":                       0.0,
		"protocolDestinations":           bson.A{},
		"sourceDataUpdate":               nil,
		"substituted":                    false,
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
}

// autoCreateFor returns the documents to insert for a value whose address has
// not been seen before, or nil when nothing is to be created.
//
// A supervised point of a controllable family gets a command twin as well, so
// that an operator can act on what the outstation reports. The twin is
// allocated first so that its id is the lower of the two, as in the C++ driver.
func autoCreateFor(ctx context.Context, conn *Connection, rtd *mongo.Collection, iv Dnp3Value) []any {
	if !conn.AutoCreateTags {
		return nil
	}
	key := [2]int{iv.BaseGroup, iv.Address}
	if conn.insertedAddresses[key] {
		return nil
	}
	conn.insertedAddresses[key] = true

	var docs []any
	commandID := 0.0

	if conn.CommandsEnabled &&
		(iv.BaseGroup == dnp3util.GroupBinaryOutputStatus || iv.BaseGroup == dnp3util.GroupAnalogOutputStatus) {

		commandID = nextAutoKey(ctx, conn, rtd)
		cmdGroup := dnp3util.GroupAnalogOutputBlock
		asdu := 3.0
		duration := 0.0
		if iv.BaseGroup == dnp3util.GroupBinaryOutputStatus {
			cmdGroup = dnp3util.GroupCROBCommand
			asdu = 1.0
			duration = 3.0 // LATCH 1=ON 0=OFF
		}
		docs = append(docs, newTagDoc(iv, conn.Name, commandID, true, cmdGroup, asdu, duration,
			0.0, commandID+1.0))
		conn.insertedAddresses[[2]int{cmdGroup, iv.Address}] = true
		jscfg.Log(jscfg.LogLevelBasic, "%s - INSERT NEW COMMAND TAG: %s;%d;%d",
			conn.Name, conn.Name, cmdGroup, iv.Address)
	}

	newID := nextAutoKey(ctx, conn, rtd)
	docs = append(docs, newTagDoc(iv, conn.Name, newID, false, iv.BaseGroup, 0.0, 0.0, commandID, 0.0))
	jscfg.Log(jscfg.LogLevelBasic, "%s - INSERT NEW TAG: %s;%d;%d",
		conn.Name, conn.Name, iv.BaseGroup, iv.Address)

	return docs
}
