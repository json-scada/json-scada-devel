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

// The two reserved system points, created on first run exactly as
// createSpecialTags() does in the Node.js implementation.

package main

import (
	"context"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

func createSpecialTags(ctx context.Context) {
	rt, _, _, _, _, ok := Mongo.Handles()
	if !ok {
		return
	}
	opCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	epoch2000 := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

	// ---- alarm beep point ----
	var found bson.Raw
	err := rt.FindOne(opCtx, bson.D{{Key: "_id", Value: beepPointKey}}).Decode(&found)
	if err == mongo.ErrNoDocuments {
		doc := specialTagBase(beepPointKey, epoch2000)
		doc = append(doc,
			bson.E{Key: "description", Value: "_System~Status~Alarm Beep"},
			bson.E{Key: "eventTextFalse", Value: "Beep Deactivated"},
			bson.E{Key: "eventTextTrue", Value: "Beep Activated"},
			bson.E{Key: "stateTextFalse", Value: "No Beep"},
			bson.E{Key: "stateTextTrue", Value: "Active Beep"},
			bson.E{Key: "tag", Value: "_System.Status.AlarmBeep"},
			bson.E{Key: "ungroupedDescription", Value: "Alarm Beep"},
			bson.E{Key: "unit", Value: "Enum"},
			bson.E{Key: "valueString", Value: "No Beep"},
			bson.E{Key: "beepType", Value: 0.0},
			bson.E{Key: "beepGroup1List", Value: bson.A{}},
		)
		if _, err := rt.InsertOne(opCtx, doc); err != nil {
			Log(LogLevelMin, "Error on Mongodb query! %v", err)
		} else {
			Log(LogLevelMin, "Created special tag _System.Status.AlarmBeep")
		}
	} else if err == nil {
		// older installations may not have the beep group list
		if _, err := rt.UpdateOne(opCtx, bson.D{
			{Key: "_id", Value: beepPointKey},
			{Key: "beepGroup1List", Value: bson.D{{Key: "$exists", Value: false}}},
		}, bson.D{{Key: "$set", Value: bson.D{{Key: "beepGroup1List", Value: bson.A{}}}}}); err != nil {
			Log(LogLevelMin, "Error on Mongodb query! %v", err)
		}
	} else {
		Log(LogLevelMin, "Error on Mongodb query! %v", err)
	}

	// ---- digital updates counter point ----
	err = rt.FindOne(opCtx, bson.D{{Key: "_id", Value: cntUpdatesPointKey}}).Decode(&found)
	if err == mongo.ErrNoDocuments {
		doc := specialTagBase(cntUpdatesPointKey, epoch2000)
		doc = append(doc,
			bson.E{Key: "description", Value: "_System~Status~Digital Updates Count"},
			bson.E{Key: "eventTextFalse", Value: ""},
			bson.E{Key: "eventTextTrue", Value: ""},
			bson.E{Key: "stateTextFalse", Value: ""},
			bson.E{Key: "stateTextTrue", Value: ""},
			bson.E{Key: "tag", Value: "_System.Status.DigitalUpdatesCnt"},
			bson.E{Key: "ungroupedDescription", Value: "Digital Updates Count"},
			bson.E{Key: "unit", Value: "Updates"},
			bson.E{Key: "valueString", Value: "0 Updates"},
		)
		if _, err := rt.InsertOne(opCtx, doc); err != nil {
			Log(LogLevelMin, "Error on Mongodb query! %v", err)
		} else {
			Log(LogLevelMin, "Created special tag _System.Status.DigitalUpdatesCnt")
		}
	} else if err != nil && err != mongo.ErrNoDocuments {
		Log(LogLevelMin, "Error on Mongodb query! %v", err)
	}
}

// specialTagBase holds the fields shared by both reserved points.
func specialTagBase(id float64, timeTag time.Time) bson.D {
	return bson.D{
		{Key: "_id", Value: id},
		{Key: "alarmRange", Value: 0.0},
		{Key: "alarmDisabled", Value: true},
		{Key: "alarmState", Value: 1.0},
		{Key: "alarmed", Value: false},
		{Key: "annotation", Value: ""},
		{Key: "commandBlocked", Value: false},
		{Key: "commandOfSupervised", Value: 0.0},
		{Key: "formula", Value: nil},
		{Key: "frozen", Value: false},
		{Key: "frozenDetectTimeout", Value: 300.0},
		{Key: "group1", Value: "_System"},
		{Key: "group2", Value: "Status"},
		{Key: "group3", Value: ""},
		{Key: "hiLimit", Value: nil},
		{Key: "hihiLimit", Value: nil},
		{Key: "hihihiLimit", Value: nil},
		{Key: "historianDeadBand", Value: 0.0},
		{Key: "historianPeriod", Value: 0.0},
		{Key: "hysteresis", Value: 0.0},
		{Key: "invalid", Value: true},
		{Key: "invalidDetectTimeout", Value: 0.0},
		{Key: "isEvent", Value: false},
		{Key: "kconv1", Value: 1.0},
		{Key: "kconv2", Value: 0.0},
		{Key: "loLimit", Value: nil},
		{Key: "location", Value: nil},
		{Key: "loloLimit", Value: nil},
		{Key: "lololoLimit", Value: nil},
		{Key: "notes", Value: ""},
		{Key: "origin", Value: "system"},
		{Key: "overflow", Value: false},
		{Key: "parcels", Value: nil},
		{Key: "priority", Value: 3.0},
		{Key: "protocolSourceASDU", Value: 0.0},
		{Key: "protocolSourceCommandDuration", Value: nil},
		{Key: "protocolSourceCommandUseSBO", Value: nil},
		{Key: "protocolSourceCommonAddress", Value: 0.0},
		{Key: "protocolSourceConnectionNumber", Value: 0.0},
		{Key: "protocolSourceObjectAddress", Value: 0.0},
		{Key: "sourceDataUpdate", Value: nil},
		{Key: "substituted", Value: false},
		{Key: "supervisedOfCommand", Value: 0.0},
		{Key: "timeTag", Value: timeTag},
		{Key: "transient", Value: false},
		{Key: "type", Value: "analog"},
		{Key: "updatesCnt", Value: 0.0},
		{Key: "value", Value: 0.0},
		{Key: "valueDefault", Value: 0.0},
		{Key: "timeTagAtSource", Value: nil},
		{Key: "timeTagAtSourceOk", Value: nil},
	}
}
