﻿/* 
 * OPC-UA Client Protocol driver for {json:scada}
 * {json:scada} - Copyright (c) 2020-2025 - Ricardo L. Olsen
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

using System;
using MongoDB.Bson;
using MongoDB.Bson.Serialization;
using MongoDB.Bson.Serialization.Attributes;

partial class MainClass
{
    [BsonIgnoreExtraElements]
    public class rtDataId
    {
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble _id = 0.0;
    }
    [BsonIgnoreExtraElements]
    public class protocolDestination
    {
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble protocolDestinationConnectionNumber = 0.0;
        public BsonDouble protocolDestinationCommonAddress = 0.0;
        public BsonDouble protocolDestinationObjectAddress = 0.0;
        public BsonDouble protocolDestinationASDU = 0.0;
        public BsonDouble protocolDestinationCommandDuration = 0.0;
        public BsonBoolean protocolDestinationCommandUseSBO = false;
        public BsonDouble protocolDestinationKConv1 = 1.0;
        public BsonDouble protocolDestinationKConv2 = 0.0;
        public BsonDouble protocolDestinationGroup = 0.0;
        public BsonDouble protocolDestinationHoursShift = 0.0;

    }

    [BsonIgnoreExtraElements]
    public class rtData
    {
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble _id;
        [BsonDefaultValue(false)]
        public BsonBoolean alarmDisabled { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble alarmState;
        [BsonDefaultValue(false)]
        public BsonBoolean alarmed { get; set; }
        [BsonDefaultValue(false)]
        public BsonBoolean alerted { get; set; }
        [BsonDefaultValue("")]
        public BsonString alertState { get; set; }
        [BsonDefaultValue("")]
        public BsonString annotation { get; set; }
        [BsonDefaultValue(false)]
        public BsonBoolean commandBlocked { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble commandOfSupervised;
        [BsonDefaultValue("")]
        public BsonString commissioningRemarks { get; set; }
        [BsonDefaultValue("")]
        public BsonString description { get; set; }
        [BsonDefaultValue("")]
        public BsonString eventTextFalse { get; set; }
        [BsonDefaultValue("")]
        public BsonString eventTextTrue { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble formula;
        [BsonDefaultValue(false)]
        public BsonBoolean frozen { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble frozenDetectTimeout;
        [BsonDefaultValue("")]
        public BsonString group1 { get; set; }
        [BsonDefaultValue("")]
        public BsonString group2 { get; set; }
        [BsonDefaultValue("")]
        public BsonString group3 { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(Double.MaxValue)]
        public BsonDouble hiLimit;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(Double.MaxValue)]
        public BsonDouble hihiLimit;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(Double.MaxValue)]
        public BsonDouble hihihiLimit;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble historianDeadBand;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble historianPeriod;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble hysteresis;
        [BsonDefaultValue(true)]
        public BsonBoolean invalid { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(60000.0)]
        public BsonDouble invalidDetectTimeout;
        [BsonDefaultValue(false)]
        public BsonBoolean isEvent { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(1.0)]
        public BsonDouble kconv1;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble kconv2;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(-Double.MaxValue)]
        public BsonDouble loLimit;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(-Double.MaxValue)]
        public BsonDouble loloLimit;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(-Double.MaxValue)]
        public BsonDouble lololoLimit;
        [BsonDefaultValue(null)]
        public BsonValue location;
        [BsonDefaultValue("")]
        public BsonString notes { get; set; }
        [BsonDefaultValue("supervised")]
        public BsonString origin { get; set; }
        [BsonDefaultValue(false)]
        public BsonBoolean overflow { get; set; }
        [BsonDefaultValue(null)]
        public BsonValue parcels;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble priority;
        [BsonDefaultValue(null)]
        public protocolDestination[] protocolDestinations;
        [BsonDefaultValue("")]
        public BsonString protocolSourceBrowsePath { get; set; }
        [BsonDefaultValue("")]
        public BsonString protocolSourceAccessLevel { get; set; }
        [BsonDefaultValue("")]
        public BsonString protocolSourceASDU { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble protocolSourceCommandDuration;
        [BsonDefaultValue(false)]
        public BsonBoolean protocolSourceCommandUseSBO { get; set; }
        [BsonDefaultValue("")]
        public BsonString protocolSourceCommonAddress { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble protocolSourceConnectionNumber;
        [BsonDefaultValue("")]
        public BsonString protocolSourceObjectAddress { get; set; }

        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(5.0)]
        public BsonDouble protocolSourcePublishingInterval { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(2.0)]
        public BsonDouble protocolSourceSamplingInterval { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(10.0)]
        public BsonDouble protocolSourceQueueSize { get; set; }
        [BsonDefaultValue(true)]
        public BsonBoolean protocolSourceDiscardOldest { get; set; }

        [BsonDefaultValue(null)]
        public BsonValue sourceDataUpdate { get; set; }
        [BsonDefaultValue("")]
        public BsonString stateTextFalse { get; set; }
        [BsonDefaultValue("")]
        public BsonString stateTextTrue { get; set; }
        [BsonDefaultValue(false)]
        public BsonBoolean substituted { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble supervisedOfCommand;
        [BsonDefaultValue("")]
        public BsonString tag { get; set; }
        [BsonDefaultValue(null)]
        public BsonValue timeTag { get; set; }
        [BsonDefaultValue(null)]
        public BsonValue timeTagAlarm { get; set; }
        [BsonDefaultValue(null)]
        public BsonValue timeTagAtSource { get; set; }
        [BsonDefaultValue(false)]
        public BsonBoolean timeTagAtSourceOk { get; set; }
        [BsonDefaultValue(false)]
        public BsonBoolean transient { get; set; }
        [BsonDefaultValue("digital")]
        public BsonString type { get; set; }
        [BsonDefaultValue("")]
        public BsonString ungroupedDescription { get; set; }
        [BsonDefaultValue("")]
        public BsonString unit { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble updatesCnt;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble valueDefault;
        [BsonDefaultValue("")]
        public BsonString valueJson { get; set; }
        [BsonDefaultValue("")]
        public BsonString valueString { get; set; }
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble value;
        [BsonSerializer(typeof(BsonDoubleSerializer)), BsonDefaultValue(0.0)]
        public BsonDouble zeroDeadband;

    }
    public static rtData newRealtimeDoc(OPC_Value ov, double _id, double commandOfSupervised)
    {
        var type = "analog";
        switch (ov.asdu.ToLower())
        {
            case "boolean":
                type = "digital";
                break;
            case "string":
            case "bytestring":
            case "localeid":
            case "localizedtext":
            case "xmlelement":
            case "qualifiedname":
            case "guid":
                type = "string";
                break;
            case "nodeid":
            case "expandednodeid":
            case "extensionobject":
                type = "json";
                break;
        }
        if (ov.isArray)
            type = "json";

        if (ov.createCommandForMethod || ov.createCommandForSupervised)
        {
            return new rtData()
            {
                _id = _id,
                protocolSourceBrowsePath = ov.path,
                protocolSourceAccessLevel = Convert.ToString(ov.accessLevels),
                protocolSourceASDU = ov.asdu,
                protocolSourceCommonAddress = ov.common_address,
                protocolSourceConnectionNumber = ov.conn_number,
                protocolSourceObjectAddress = ov.address,
                protocolSourceCommandUseSBO = false,
                protocolSourceCommandDuration = 0.0,
                protocolSourcePublishingInterval = 0.0,
                protocolSourceSamplingInterval = 0.0,
                protocolSourceQueueSize = 0.0,
                protocolSourceDiscardOldest = true,
                alarmState = 2.0,
                description = ov.conn_name + "~" + ov.path + "~" + ov.display_name + "-Command",
                ungroupedDescription = ov.display_name,
                group1 = ov.conn_name,
                group2 = ov.path,
                group3 = "",
                stateTextFalse = type == "digital" ? "FALSE" : "",
                stateTextTrue = type == "digital" ? "TRUE" : "",
                eventTextFalse = type == "digital" ? "FALSE" : "",
                eventTextTrue = type == "digital" ? "TRUE" : "",
                origin = "command",
                tag = TagFromOPCParameters(ov) + ";cmd",
                type = type,
                value = 0.0,
                valueString = "????",
                alarmDisabled = false,
                alerted = false,
                alarmed = false,
                alertState = "",
                annotation = "",
                commandBlocked = false,
                commandOfSupervised = 0.0,
                commissioningRemarks = "",
                formula = 0.0,
                frozen = false,
                frozenDetectTimeout = 0.0,
                hiLimit = Double.MaxValue,
                hihiLimit = Double.MaxValue,
                hihihiLimit = Double.MaxValue,
                historianDeadBand = 0.0,
                historianPeriod = 0.0,
                hysteresis = 0.0,
                invalid = true,
                invalidDetectTimeout = 60000,
                isEvent = false,
                kconv1 = 1.0,
                kconv2 = 0.0,
                location = BsonNull.Value,
                loLimit = -Double.MaxValue,
                loloLimit = -Double.MaxValue,
                lololoLimit = -Double.MaxValue,
                notes = "",
                overflow = false,
                parcels = BsonNull.Value,
                priority = 0.0,
                protocolDestinations = new protocolDestination[] { },
                sourceDataUpdate = BsonNull.Value,
                supervisedOfCommand = ov.createCommandForSupervised ? _id + 1 : 0.0,
                substituted = false,
                timeTag = BsonNull.Value,
                timeTagAlarm = BsonNull.Value,
                timeTagAtSource = BsonNull.Value,
                timeTagAtSourceOk = false,
                transient = false,
                unit = "",
                updatesCnt = 0,
                valueDefault = 0.0,
                zeroDeadband = 0.0
            };
        }
        else
        if (type == "digital")
            return new rtData()
            {
                _id = _id,
                protocolSourceBrowsePath = ov.path,
                protocolSourceAccessLevel = Convert.ToString(ov.accessLevels),
                protocolSourceASDU = ov.asdu,
                protocolSourceCommonAddress = ov.common_address,
                protocolSourceConnectionNumber = ov.conn_number,
                protocolSourceObjectAddress = ov.address,
                protocolSourceCommandUseSBO = false,
                protocolSourceCommandDuration = 0.0,
                protocolSourcePublishingInterval = 5.0,
                protocolSourceSamplingInterval = 2.0,
                protocolSourceQueueSize = 10.0,
                protocolSourceDiscardOldest = true,
                alarmState = 2.0,
                description = ov.conn_name + "~" + ov.path + "~" + ov.display_name,
                ungroupedDescription = ov.display_name,
                group1 = ov.conn_name,
                group2 = ov.path,
                group3 = "",
                stateTextFalse = "FALSE",
                stateTextTrue = "TRUE",
                eventTextFalse = "FALSE",
                eventTextTrue = "TRUE",
                origin = "supervised",
                tag = TagFromOPCParameters(ov),
                type = type,
                value = ov.value,
                valueString = "????",
                alarmDisabled = false,
                alerted = false,
                alarmed = false,
                alertState = "",
                annotation = "",
                commandBlocked = false,
                commandOfSupervised = commandOfSupervised,
                commissioningRemarks = "",
                formula = 0.0,
                frozen = false,
                frozenDetectTimeout = 0.0,
                hiLimit = Double.MaxValue,
                hihiLimit = Double.MaxValue,
                hihihiLimit = Double.MaxValue,
                historianDeadBand = 0.0,
                historianPeriod = 0.0,
                hysteresis = 0.0,
                invalid = true,
                invalidDetectTimeout = 60000,
                isEvent = false,
                kconv1 = 1.0,
                kconv2 = 0.0,
                location = BsonNull.Value,
                loLimit = -Double.MaxValue,
                loloLimit = -Double.MaxValue,
                lololoLimit = -Double.MaxValue,
                notes = "",
                overflow = false,
                parcels = BsonNull.Value,
                priority = 0.0,
                protocolDestinations = new protocolDestination[] { },
                sourceDataUpdate = BsonNull.Value,
                supervisedOfCommand = 0.0,
                substituted = false,
                timeTag = BsonNull.Value,
                timeTagAlarm = BsonNull.Value,
                timeTagAtSource = BsonNull.Value,
                timeTagAtSourceOk = false,
                transient = false,
                unit = "",
                updatesCnt = 0,
                valueDefault = 0.0,
                zeroDeadband = 0.0
            };
        else
        if (type == "string")
            return new rtData()
            {
                _id = _id,
                protocolSourceBrowsePath = ov.path,
                protocolSourceAccessLevel = Convert.ToString(ov.accessLevels),
                protocolSourceASDU = ov.asdu,
                protocolSourceCommonAddress = ov.common_address,
                protocolSourceConnectionNumber = ov.conn_number,
                protocolSourceObjectAddress = ov.address,
                protocolSourceCommandUseSBO = false,
                protocolSourceCommandDuration = 0.0,
                protocolSourcePublishingInterval = 5.0,
                protocolSourceSamplingInterval = 2.0,
                protocolSourceQueueSize = 10.0,
                protocolSourceDiscardOldest = true,
                alarmState = -1.0,
                description = ov.conn_name + "~" + ov.path + "~" + ov.display_name,
                ungroupedDescription = ov.display_name,
                group1 = ov.conn_name,
                group2 = ov.path,
                group3 = "",
                stateTextFalse = "",
                stateTextTrue = "",
                eventTextFalse = "",
                eventTextTrue = "",
                origin = "supervised",
                tag = TagFromOPCParameters(ov),
                type = type,
                value = 0.0,
                valueString = ov.valueString,

                alarmDisabled = false,
                alerted = false,
                alarmed = false,
                alertState = "",
                annotation = "",
                commandBlocked = false,
                commandOfSupervised = commandOfSupervised,
                commissioningRemarks = "",
                formula = 0.0,
                frozen = false,
                frozenDetectTimeout = 0.0,
                hiLimit = Double.MaxValue,
                hihiLimit = Double.MaxValue,
                hihihiLimit = Double.MaxValue,
                historianDeadBand = 0.0,
                historianPeriod = 0.0,
                hysteresis = 0.0,
                invalid = true,
                invalidDetectTimeout = 60000,
                isEvent = false,
                kconv1 = 1.0,
                kconv2 = 0.0,
                location = BsonNull.Value,
                loLimit = -Double.MaxValue,
                loloLimit = -Double.MaxValue,
                lololoLimit = -Double.MaxValue,
                notes = "",
                overflow = false,
                parcels = BsonNull.Value,
                priority = 0.0,
                protocolDestinations = new protocolDestination[] { },
                sourceDataUpdate = BsonNull.Value,
                supervisedOfCommand = 0.0,
                substituted = false,
                timeTag = BsonNull.Value,
                timeTagAlarm = BsonNull.Value,
                timeTagAtSource = BsonNull.Value,
                timeTagAtSourceOk = false,
                transient = false,
                unit = "",
                updatesCnt = 0,
                valueDefault = 0.0,
                zeroDeadband = 0.0,
            };
        else
        if (type == "json")
            return new rtData()
            {
                _id = _id,
                protocolSourceBrowsePath = ov.path,
                protocolSourceAccessLevel = Convert.ToString(ov.accessLevels),
                protocolSourceASDU = ov.asdu,
                protocolSourceCommonAddress = ov.common_address,
                protocolSourceConnectionNumber = ov.conn_number,
                protocolSourceObjectAddress = ov.address,
                protocolSourceCommandUseSBO = false,
                protocolSourceCommandDuration = 0.0,
                protocolSourcePublishingInterval = 5.0,
                protocolSourceSamplingInterval = 2.0,
                protocolSourceQueueSize = 10.0,
                protocolSourceDiscardOldest = true,
                alarmState = -1.0,
                description = ov.conn_name + "~" + ov.path + "~" + ov.display_name,
                ungroupedDescription = ov.display_name,
                group1 = ov.conn_name,
                group2 = ov.path,
                group3 = "",
                stateTextFalse = "",
                stateTextTrue = "",
                eventTextFalse = "",
                eventTextTrue = "",
                origin = "supervised",
                tag = TagFromOPCParameters(ov),
                type = type,
                value = 0.0,
                valueString = ov.valueString,
                valueJson = ov.valueJson,

                alarmDisabled = false,
                alerted = false,
                alarmed = false,
                alertState = "",
                annotation = "",
                commandBlocked = false,
                commandOfSupervised = commandOfSupervised,
                commissioningRemarks = "",
                formula = 0.0,
                frozen = false,
                frozenDetectTimeout = 0.0,
                hiLimit = Double.MaxValue,
                hihiLimit = Double.MaxValue,
                hihihiLimit = Double.MaxValue,
                historianDeadBand = 0.0,
                historianPeriod = 0.0,
                hysteresis = 0.0,
                invalid = true,
                invalidDetectTimeout = 60000,
                isEvent = false,
                kconv1 = 1.0,
                kconv2 = 0.0,
                location = BsonNull.Value,
                loLimit = -Double.MaxValue,
                loloLimit = -Double.MaxValue,
                lololoLimit = -Double.MaxValue,
                notes = "",
                overflow = false,
                parcels = BsonNull.Value,
                priority = 0.0,
                protocolDestinations = new protocolDestination[] { },
                sourceDataUpdate = BsonNull.Value,
                supervisedOfCommand = 0.0,
                substituted = false,
                timeTag = BsonNull.Value,
                timeTagAlarm = BsonNull.Value,
                timeTagAtSource = BsonNull.Value,
                timeTagAtSourceOk = false,
                transient = false,
                unit = "",
                updatesCnt = 0,
                valueDefault = 0.0,
                zeroDeadband = 0.0,
            };

        return new rtData()
        {
            _id = _id,
            protocolSourceBrowsePath = ov.path,
            protocolSourceAccessLevel = Convert.ToString(ov.accessLevels),
            protocolSourceASDU = ov.asdu,
            protocolSourceCommonAddress = ov.common_address,
            protocolSourceConnectionNumber = ov.conn_number,
            protocolSourceObjectAddress = ov.address,
            protocolSourceCommandUseSBO = false,
            protocolSourceCommandDuration = 0.0,
            protocolSourcePublishingInterval = 5.0,
            protocolSourceSamplingInterval = 2.0,
            protocolSourceQueueSize = 10.0,
            protocolSourceDiscardOldest = true,
            alarmState = -1.0,
            description = ov.conn_name + "~" + ov.path + "~" + ov.display_name,
            ungroupedDescription = ov.display_name,
            group1 = ov.conn_name,
            group2 = ov.path,
            group3 = "",
            stateTextFalse = "",
            stateTextTrue = "",
            eventTextFalse = "",
            eventTextTrue = "",
            origin = "supervised",
            tag = TagFromOPCParameters(ov),
            type = type,
            value = ov.value,
            valueString = "????",

            alarmDisabled = false,
            alerted = false,
            alarmed = false,
            alertState = "",
            annotation = "",
            commandBlocked = false,
            commandOfSupervised = commandOfSupervised,
            commissioningRemarks = "",
            formula = 0.0,
            frozen = false,
            frozenDetectTimeout = 0.0,
            hiLimit = Double.MaxValue,
            hihiLimit = Double.MaxValue,
            hihihiLimit = Double.MaxValue,
            historianDeadBand = 0.0,
            historianPeriod = 0.0,
            hysteresis = 0.0,
            invalid = true,
            invalidDetectTimeout = 60000,
            isEvent = false,
            kconv1 = 1.0,
            kconv2 = 0.0,
            location = BsonNull.Value,
            loLimit = -Double.MaxValue,
            loloLimit = -Double.MaxValue,
            lololoLimit = -Double.MaxValue,
            notes = "",
            overflow = false,
            parcels = BsonNull.Value,
            priority = 0.0,
            protocolDestinations = new protocolDestination[] { },
            sourceDataUpdate = BsonNull.Value,
            supervisedOfCommand = 0.0,
            substituted = false,
            timeTag = BsonNull.Value,
            timeTagAlarm = BsonNull.Value,
            timeTagAtSource = BsonNull.Value,
            timeTagAtSourceOk = false,
            transient = false,
            unit = "",
            updatesCnt = 0,
            valueDefault = 0.0,
            zeroDeadband = 0.0
        };
    }
}
