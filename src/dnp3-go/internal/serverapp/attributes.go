/*
 * DNP3 Outstation Server Protocol driver for {json:scada}, in Go.
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

// Device attributes, group 0: the outstation's answer to "what are you?".
//
// A master commissioning an unfamiliar panel reads these instead of trusting a
// drawing, and an engineer with a protocol analyser reads them to find out
// which of several identical-looking gateways they are talking to. The C++
// server answers none of it — opendnp3 has no group 0 support — so this is new
// (deviation D24).
//
// The whole of set 0 that a gateway can answer truthfully is reported here.
// go-dnp3 derives the point counts and fragment sizes on its own, but only
// those, and it leaves out a point type the database does not have. This set
// adds, per point type, whether it reports events and its highest index, and
// reports every type including the empty ones, so a master reads one complete
// capacity block. Configured attributes replace derived ones key by key, so
// the counts and sizes a master reads are this set's; TestAttributesCoverDerived
// checks that every key the library derives is answered here, so the two can
// never be mixed in one response.

package serverapp

import (
	"runtime"
	"strconv"

	dnp3 "github.com/dscsystems/go-dnp3"
	"github.com/dscsystems/go-dnp3/objects"
	"github.com/dscsystems/go-dnp3/outstation"
)

// Standard set 0 variations, as IEEE 1815-2012 numbers them (the same table
// Wireshark's dissector and stepfunc's dnp3 crate use). They are named here
// rather than taken from the library's display table because these are
// numbers used to answer a request, not labels — and the library's table is
// the one with the numbers wrong.
const (
	attrSystemName        uint8 = 208
	attrUserSpecificSets  uint8 = 211
	attrMaxCROBPerRequest uint8 = 216

	attrAOEventsSupported  uint8 = 219
	attrMaxAOIndex         uint8 = 220
	attrNumAO              uint8 = 221
	attrBOEventsSupported  uint8 = 222
	attrMaxBOIndex         uint8 = 223
	attrNumBO              uint8 = 224
	attrFrozenCounterEvts  uint8 = 225
	attrFrozenCounters     uint8 = 226
	attrCounterEvents      uint8 = 227
	attrMaxCounterIndex    uint8 = 228
	attrNumCounter         uint8 = 229
	attrFrozenAnalogInputs uint8 = 230
	attrAIEventsSupported  uint8 = 231
	attrMaxAIIndex         uint8 = 232
	attrNumAI              uint8 = 233
	attrDBIEventsSupported uint8 = 234
	attrMaxDBIIndex        uint8 = 235
	attrNumDBI             uint8 = 236
	attrBIEventsSupported  uint8 = 237
	attrMaxBIIndex         uint8 = 238
	attrNumBI              uint8 = 239
	attrMaxTxFragment      uint8 = 240
	attrMaxRxFragment      uint8 = 241

	attrSoftwareVersion uint8 = 242
	attrHardwareVersion uint8 = 243
	attrLocation        uint8 = 245
	attrIDCode          uint8 = 246
	attrDeviceName      uint8 = 247
	attrProductName     uint8 = 250
	attrManufacturer    uint8 = 252
)

// Identity reported by every connection of this driver.
const (
	manufacturerName = "{json:scada}"
	productName      = "JSON-SCADA DNP3 Outstation Server (Go)"
	systemName       = "JSON-SCADA"
)

// maxCROBPerRequest is how many control relay output blocks fit one request
// fragment of maxRxFragment octets. The library sets no limit of its own, so
// the fragment is the limit. The figure assumes the widest encoding a master
// may use for any index — a two-octet count and a two-octet index prefix, 13
// octets per CROB after the 2-octet application header and the 5-octet object
// header — so it holds whatever indexes are addressed.
const maxCROBPerRequest = (maxRxFragment - 2 - 5) / (2 + 11)

// deviceAttributes describes one connection to a master that asks.
//
// Deliberately absent:
//
//   - Subset level and conformance (249). Nothing in this repository has been
//     through certified conformance testing, and the library's own device
//     profile says as much. Answering it would be a claim, not a fact.
//   - Serial number (248). A gateway has no serial number to give, and
//     inventing one from a connection number invites somebody to key an asset
//     register off it.
//   - Owner and operator names (244, 206, 207), location coordinates (203 to
//     205), configuration identity (196 to 202), time accuracy (217, 218) and
//     the secure authentication and data set counts (209, 210, 212 to 215):
//     nothing in the connection document says any of them.
//
// A master reading an attribute the outstation does not report learns that it
// does not report it, which is true, whereas a plausible wrong value
// propagates.
func deviceAttributes(conn *Connection, db outstation.DatabaseConfig) []dnp3.Attribute {
	attrs := []dnp3.Attribute{
		objects.StringAttribute(attrManufacturer, manufacturerName),
		objects.StringAttribute(attrProductName, productName),
		objects.StringAttribute(attrSoftwareVersion, DriverVersion),
		// The host platform is the nearest honest thing to hardware for a
		// software outstation, and it is what an engineer wants when a
		// gateway misbehaves on one machine and not another.
		objects.StringAttribute(attrHardwareVersion, runtime.GOOS+"/"+runtime.GOARCH),
		objects.StringAttribute(attrSystemName, systemName),
		// No private attribute sets are defined, which the standard expresses
		// as an empty list.
		objects.StringAttribute(attrUserSpecificSets, ""),
	}

	// The connection name is what the tag names of this driver are built from
	// and what every log line is prefixed with, so it is the name that
	// identifies this outstation everywhere else in the system.
	if conn.Name != "" {
		attrs = append(attrs, objects.StringAttribute(attrDeviceName, conn.Name))
	}
	// The description exists in protocolConnections and is documented as
	// purely documental; reporting it is how it reaches the field.
	if conn.Description != "" {
		attrs = append(attrs, objects.StringAttribute(attrLocation, conn.Description))
	}
	// The connection number is unique across every driver of an installation,
	// which makes it the one identifier that tells two otherwise identical
	// outstations apart.
	attrs = append(attrs, objects.StringAttribute(attrIDCode,
		strconv.Itoa(conn.ProtocolConnectionNumber)))

	attrs = append(attrs,
		objects.UintAttribute(attrMaxTxFragment, maxTxFragment),
		objects.UintAttribute(attrMaxRxFragment, maxRxFragment),
		objects.UintAttribute(attrMaxCROBPerRequest, maxCROBPerRequest),
		// go-dnp3 has no frozen analog inputs (groups 31 and 33).
		boolAttribute(attrFrozenAnalogInputs, false),
		// Frozen counters exist exactly when the database has any: the freeze
		// functions copy counters into them, and a database without them has
		// nowhere to freeze to.
		boolAttribute(attrFrozenCounters, db.FrozenCounter > 0),
		boolAttribute(attrFrozenCounterEvts, db.FrozenCounter > 0),
	)

	// One block per point type: whether it reports events, its highest index
	// and how many points it has. Every point the server configures is given
	// an event class (defaultClasses), so a type that exists reports events.
	for _, b := range []struct {
		events, maxIndex, count uint8
		n                       int
	}{
		{attrBIEventsSupported, attrMaxBIIndex, attrNumBI, db.Binary},
		{attrDBIEventsSupported, attrMaxDBIIndex, attrNumDBI, db.DoubleBitBinary},
		{attrAIEventsSupported, attrMaxAIIndex, attrNumAI, db.Analog},
		{attrCounterEvents, attrMaxCounterIndex, attrNumCounter, db.Counter},
		{attrBOEventsSupported, attrMaxBOIndex, attrNumBO, db.BinaryOutputStatus},
		{attrAOEventsSupported, attrMaxAOIndex, attrNumAO, db.AnalogOutputStatus},
	} {
		attrs = append(attrs,
			boolAttribute(b.events, b.n > 0),
			// A type with no points has no highest index; 0 alongside a count
			// of 0 is the conventional answer. The block is reported whole
			// rather than skipped, so a master can tell "none" from "not said".
			objects.UintAttribute(b.maxIndex, uint64(max(b.n-1, 0))),
			objects.UintAttribute(b.count, uint64(b.n)),
		)
	}

	return attrs
}

// boolAttribute encodes a "support for" attribute. IEEE 1815 types them as a
// signed integer, 1 for yes and 0 for no.
func boolAttribute(variation uint8, v bool) dnp3.Attribute {
	n := int64(0)
	if v {
		n = 1
	}
	return objects.IntAttribute(variation, n)
}
