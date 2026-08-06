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

// Server model discovery: logical devices, logical nodes, data objects,
// data sets and report control blocks. Port of the discovery part of
// Process(Iec61850Connection) in the C# driver, using the ACSI directory
// services of go-iec61850 v0.2.x instead of hand-built MMS name lists.

package main

import (
	"context"
	"strings"
	"time"

	"github.com/dscsystems/go-iec61850/client"
	"github.com/dscsystems/go-iec61850/mms"
	"github.com/dscsystems/go-iec61850/model"
)

// discoverServer walks the server directory, links data sets to configured
// entries and activates the report control blocks.
func discoverServer(ctx context.Context, conn *Iec61850Connection) error {
	cli := conn.Client()

	// Discovery is many requests over a large model, so it gets a budget of
	// its own rather than the per-request one.
	budget := conn.requestTimeout() * 20
	if budget < time.Minute {
		budget = time.Minute
	}
	dirCtx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()

	lds, err := cli.LogicalDevices(dirCtx)
	if err != nil {
		return err
	}

	for _, ld := range lds {
		Log(LogLevelBasic, "%s LD: %s", conn.Name, ld)

		lns, err := cli.LogicalNodes(dirCtx, ld)
		if err != nil {
			return err
		}

		// One name-list pass covers every class we care about.
		classes := []client.ACSIClass{client.ACSIDataObject, client.ACSIDataSet}
		if conn.UseUrcb {
			classes = append(classes, client.ACSIURCB)
		}
		if conn.UseBrcb {
			classes = append(classes, client.ACSIBRCB)
		}
		found, err := cli.Browse(dirCtx, ld, classes...)
		if err != nil {
			return err
		}

		byLN := map[string]map[client.ACSIClass][]model.ObjectReference{}
		for _, e := range found {
			ln := e.Ref.LN()
			if byLN[ln] == nil {
				byLN[ln] = map[client.ACSIClass][]model.ObjectReference{}
			}
			byLN[ln][e.Class] = append(byLN[ln][e.Class], e.Ref)
		}

		for _, ln := range lns {
			Log(LogLevelBasic, "%s  LN: %s", conn.Name, ln)
			lnRef := ld + "/" + ln
			perClass := byLN[ln]

			if conn.Browse {
				for _, doRef := range perClass[client.ACSIDataObject] {
					browseDataObject(dirCtx, conn, doRef)
				}
			}

			for _, dsRef := range perClass[client.ACSIDataSet] {
				discoverDataSet(dirCtx, conn, ld, ln, dsRef)
			}

			// Buffered blocks are offered first: one report stream per data
			// set is enough (§D11), and a buffered one survives a
			// disconnection, which is what the EntryID resync is for.
			for _, rcbRef := range perClass[client.ACSIBRCB] {
				enableRCB(dirCtx, conn, rcbRef, true)
			}
			for _, rcbRef := range perClass[client.ACSIURCB] {
				enableRCB(dirCtx, conn, rcbRef, false)
			}
			_ = lnRef
		}
	}
	return nil
}

// browseDataObject logs the attributes of a data object, the equivalent of
// the C# driver's GetDataDirectoryFC walk (only when browse is enabled).
func browseDataObject(ctx context.Context, conn *Iec61850Connection, doRef model.ObjectReference) {
	cli := conn.Client()
	do := doRef.Path()
	if len(do) < 2 {
		return
	}
	Log(LogLevelBasic, "%s    DO: %s", conn.Name, strings.Join(do[1:], "."))

	for _, fc := range allFCs {
		children, err := cli.DataDirectory(ctx, doRef, fc)
		if err != nil || len(children) == 0 {
			continue
		}
		for _, child := range children {
			daRef := doRef.Child(child)
			domain, item := daRef.ToMMS(fc)
			spec, err := cli.MMS().GetVariableAccessAttributes(ctx, domain, item)
			if err != nil {
				continue
			}
			Log(LogLevelBasic, "%s      DA/SDO: [%s] %s : %s(%d) ... %s",
				conn.Name, fc, child, spec.Kind, specSize(spec), daRef)
			if spec.Kind == mms.TypeStructure {
				for _, comp := range spec.Components {
					Log(LogLevelBasic, "%s           %s : %s ... %s.%s",
						conn.Name, comp.Name, comp.Spec.Kind, daRef, comp.Name)
				}
			}
		}
	}
}

// allFCs are the functional constraints a data object can expose values
// under, used for the diagnostic browse.
var allFCs = []model.FC{
	model.ST, model.MX, model.SP, model.SV, model.CF, model.DC,
	model.SG, model.SE, model.OR, model.BL, model.EX, model.CO,
}

func specSize(spec *mms.TypeSpec) int {
	if spec == nil {
		return 0
	}
	if spec.Kind == mms.TypeStructure {
		return len(spec.Components)
	}
	if spec.Kind == mms.TypeArray {
		return spec.Elements
	}
	return spec.Size
}

// discoverDataSet lists a data set's members and links the ones that match
// a configured entry, collecting the names of their child attributes.
func discoverDataSet(ctx context.Context, conn *Iec61850Connection, ld, ln string, dsRef model.ObjectReference) {
	cli := conn.Client()
	path := dsRef.Path()
	if len(path) < 2 {
		return
	}
	dsName := path[1]
	dsFullName := ld + "/" + ln + "." + dsName
	Log(LogLevelBasic, "%s    Dataset: %s", conn.Name, dsFullName)
	conn.Datasets = append(conn.Datasets, dsName)

	members, err := cli.MMS().GetNamedVariableListAttributes(ctx, ld, ln+"$"+dsName)
	if err != nil {
		Log(LogLevelDetailed, "%s     %s - cannot read members: %v", conn.Name, dsFullName, err)
		return
	}

	for _, m := range members {
		Log(LogLevelBasic, "%s     %s -> %s", conn.Name, dsFullName, m.Item)
		ref, fc := model.FromMMS(m.Domain, m.Item)
		entry := conn.Entry(entryKey(string(ref), fc))
		if entry == nil {
			continue
		}
		conn.SetEntryDataSet(entry, dsFullName)
		Log(LogLevelBasic, "%s       Found desired entry %s", conn.Name, entry.Path)
		if conn.EntryNeedsChilds(entry) {
			spec, err := cli.MMS().GetVariableAccessAttributes(ctx, m.Domain, m.Item)
			if err == nil && spec != nil {
				for _, comp := range spec.Components {
					Log(LogLevelBasic, "%s         Child %s", conn.Name, comp.Name)
					conn.AddEntryChild(entry, comp.Name)
				}
			}
		}
	}
}
