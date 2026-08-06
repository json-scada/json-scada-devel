/*
 * IEC 61850 MMS Server driver (IEC61850-90-2 gateway) for {json:scada}, in Go.
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

// Common data class construction. The library generates every class this
// driver needs, so these are thin wrappers that fix the options the C#
// driver used (CDC_OPTION_DESC, and ORIGIN|CTL_NUM on controls). Only
// LastApplError is built by hand: it is not a common data class.

package main

import (
	"github.com/dscsystems/go-iec61850/mms"
	"github.com/dscsystems/go-iec61850/model"
)

// PointKind is the IEC 61850 class a json-scada point is mapped to; it
// decides how a value is written into the model.
type PointKind int

const (
	KindSPS PointKind = iota // single point status   (digital monitor)
	KindMV                   // measured value        (analog monitor)
	KindVSS                  // visible string status (string monitor)
	KindINS                  // integer status        (unused, kept for parity)
	KindSPC                  // controllable single point (digital command)
	KindAPC                  // controllable analogue     (analog command)
	KindINC                  // controllable integer      (unused, kept for parity)
)

func (k PointKind) String() string {
	switch k {
	case KindSPS:
		return "SPS"
	case KindMV:
		return "MV"
	case KindVSS:
		return "VSS"
	case KindINS:
		return "INS"
	case KindSPC:
		return "SPC"
	case KindAPC:
		return "APC"
	case KindINC:
		return "INC"
	}
	return "?"
}

// newMonitorObject builds the data object of a monitored point.
func newMonitorObject(name string, kind PointKind) *model.DataObject {
	switch kind {
	case KindMV:
		return model.NewDataObject(name, model.CDCMV, model.WithOptional("d"))
	case KindVSS:
		return model.NewDataObject(name, model.CDCVSS, model.WithOptional("d"))
	case KindINS:
		return model.NewDataObject(name, model.CDCINS, model.WithOptional("d"))
	default:
		return model.NewDataObject(name, model.CDCSPS, model.WithOptional("d"))
	}
}

// newCommandObject builds the data object of a command point. The control
// model follows the tag's protocolSourceCommandUseSBO, as in the C#
// driver: select-before-operate with normal security, or direct normal.
func newCommandObject(name string, kind PointKind, useSBO bool) *model.DataObject {
	ctl := model.CtlDirectNormal
	if useSBO {
		ctl = model.CtlSBONormal
	}
	cdc := model.CDCSPC
	switch kind {
	case KindAPC:
		cdc = model.CDCAPC
	case KindINC:
		cdc = model.CDCINC
	}
	return model.NewDataObject(name, cdc, model.WithOptional("d"), model.WithControlModel(ctl))
}

// valueAttrPath is the path of the value attribute inside the data object,
// and the functional constraint the object's value, quality and timestamp
// are served under.
func valueAttrPath(kind PointKind) (path []string, fc model.FC) {
	switch kind {
	case KindMV:
		return []string{"mag", "f"}, model.MX
	case KindAPC:
		return []string{"mxVal", "f"}, model.MX
	default:
		return []string{"stVal"}, model.ST
	}
}

// newLastApplError builds the LLN0 object the server fills in when it
// rejects a control. It is not a common data class, so it is assembled
// here; the attribute names are the ones server/control.go looks for.
func newLastApplError() *model.DataObject {
	return &model.DataObject{
		Name: "LastApplError",
		Attributes: []*model.DataAttribute{
			leaf("cntrlObj", model.ST, mms.TypeVisibleString, mms.NewVisibleString("")),
			leaf("Error", model.ST, mms.TypeInteger, mms.NewInt32(0)),
			{
				Name: "Origin", FC: model.ST, Kind: mms.TypeStructure,
				Children: []*model.DataAttribute{
					leaf("orCat", model.ST, mms.TypeInteger, mms.NewInt32(0)),
					leaf("orIdent", model.ST, mms.TypeOctetString, mms.NewOctetString(nil)),
				},
			},
			leaf("ctlNum", model.ST, mms.TypeUnsigned, mms.NewUint32(0)),
			leaf("AddCause", model.ST, mms.TypeInteger, mms.NewInt32(0)),
		},
	}
}

func leaf(name string, fc model.FC, kind mms.Type, v *mms.Value) *model.DataAttribute {
	return &model.DataAttribute{Name: name, FC: fc, Kind: kind, Value: v}
}

// setAttrValue assigns a value to a direct attribute of a data object,
// used for the static parts of the model (descriptions, the proxy flag).
func setAttrValue(do *model.DataObject, name string, v *mms.Value) bool {
	if do == nil {
		return false
	}
	if a := do.Attribute(name); a != nil {
		a.Value = v
		return true
	}
	return false
}
