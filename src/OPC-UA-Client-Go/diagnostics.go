/*
 * OPC-UA Client Protocol driver for {json:scada}, in Go.
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

// Per-session and per-subscription server diagnostics.
//
// deviation D23: the C# driver tags and subscribes every variable it finds,
// including the server's own bookkeeping about its clients. Those nodes
// describe sessions and subscriptions that come and go, so each connection of
// the driver creates tags that are dead by the next run, and the arrays that
// summarize them change on every request the server handles — including the
// publish responses carrying their own changes. Measured against a Prosys
// simulation server, three such arrays produced about 770 notifications per
// second each despite a 5 s sampling interval, filling the 50,000-entry
// queue and starving every real tag.
//
// This driver therefore neither discovers nor subscribes them.

package main

import (
	"strings"

	"github.com/gopcua/opcua/ua"
)

// ephemeralDiagnosticIDs are the standard ns=0 nodes whose values describe
// the server's current sessions and subscriptions.
var ephemeralDiagnosticIDs = map[uint32]bool{
	2290: true, // SubscriptionDiagnosticsArray
	3706: true, // SessionsDiagnosticsSummary
	3707: true, // SessionDiagnosticsArray
	3708: true, // SessionSecurityDiagnosticsArray
}

// ephemeralDiagnosticNames are the browse names of those nodes. A server
// publishes the per-session and per-subscription children under them with
// ids of its own choosing, so the path is what identifies the whole subtree.
var ephemeralDiagnosticNames = map[string]bool{
	"SessionsDiagnosticsSummary":      true,
	"SessionDiagnosticsArray":         true,
	"SessionSecurityDiagnosticsArray": true,
	"SubscriptionDiagnosticsArray":    true,
}

// isEphemeralDiagnostic reports whether a node is, or lies below, a
// per-session or per-subscription diagnostics node. address is the node id
// as text; path is the browse path including the node's own name, or just
// its directory when the name is not known (then only descendants and the
// standard ids are caught).
func isEphemeralDiagnostic(address, path string) bool {
	if nid, err := ua.ParseNodeID(address); err == nil &&
		nid.Namespace() == 0 && isNumericID(nid) &&
		ephemeralDiagnosticIDs[nid.IntID()] {
		return true
	}
	for _, seg := range strings.Split(path, "/") {
		if ephemeralDiagnosticNames[seg] {
			return true
		}
	}
	return false
}

// isNumericID is true for every numeric encoding; gopcua parses a small
// ns=0 id as a two-byte or four-byte node id, not a plain numeric one.
func isNumericID(nid *ua.NodeID) bool {
	switch nid.Type() {
	case ua.NodeIDTypeTwoByte, ua.NodeIDTypeFourByte, ua.NodeIDTypeNumeric:
		return true
	}
	return false
}
