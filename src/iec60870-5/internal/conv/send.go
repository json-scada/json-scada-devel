/*
 * IEC 60870-5-101/104 protocol drivers for {json:scada} - ASDU sending
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

package conv

import (
	"fmt"

	"github.com/riclolsen/go-iecp5/asdu"
)

// SendInfoBatch sends a batch of monitor-direction information objects of the
// same TypeID and common address in one ASDU (multi-object, SQ=0).
func SendInfoBatch(c asdu.Connect, coa asdu.CauseOfTransmission, ca asdu.CommonAddr, typeID asdu.TypeID, objs []*InfoObject) error {
	if len(objs) == 0 {
		return nil
	}
	switch typeID {
	case asdu.M_SP_NA_1:
		infos := make([]asdu.SinglePointInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.SinglePointInfo))
		}
		return asdu.Single(c, false, coa, ca, infos...)
	case asdu.M_SP_TB_1:
		infos := make([]asdu.SinglePointInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.SinglePointInfo))
		}
		return asdu.SingleCP56Time2a(c, coa, ca, infos...)
	case asdu.M_DP_NA_1:
		infos := make([]asdu.DoublePointInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.DoublePointInfo))
		}
		return asdu.Double(c, false, coa, ca, infos...)
	case asdu.M_DP_TB_1:
		infos := make([]asdu.DoublePointInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.DoublePointInfo))
		}
		return asdu.DoubleCP56Time2a(c, coa, ca, infos...)
	case asdu.M_ST_NA_1:
		infos := make([]asdu.StepPositionInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.StepPositionInfo))
		}
		return asdu.Step(c, false, coa, ca, infos...)
	case asdu.M_ST_TB_1:
		infos := make([]asdu.StepPositionInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.StepPositionInfo))
		}
		return asdu.StepCP56Time2a(c, coa, ca, infos...)
	case asdu.M_BO_NA_1:
		infos := make([]asdu.BitString32Info, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.BitString32Info))
		}
		return asdu.BitString32(c, false, coa, ca, infos...)
	case asdu.M_BO_TB_1:
		infos := make([]asdu.BitString32Info, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.BitString32Info))
		}
		return asdu.BitString32CP56Time2a(c, coa, ca, infos...)
	case asdu.M_ME_NA_1:
		infos := make([]asdu.MeasuredValueNormalInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.MeasuredValueNormalInfo))
		}
		return asdu.MeasuredValueNormal(c, false, coa, ca, infos...)
	case asdu.M_ME_TD_1:
		infos := make([]asdu.MeasuredValueNormalInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.MeasuredValueNormalInfo))
		}
		return asdu.MeasuredValueNormalCP56Time2a(c, coa, ca, infos...)
	case asdu.M_ME_ND_1:
		infos := make([]asdu.MeasuredValueNormalInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.MeasuredValueNormalInfo))
		}
		return asdu.MeasuredValueNormalNoQuality(c, false, coa, ca, infos...)
	case asdu.M_ME_NB_1:
		infos := make([]asdu.MeasuredValueScaledInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.MeasuredValueScaledInfo))
		}
		return asdu.MeasuredValueScaled(c, false, coa, ca, infos...)
	case asdu.M_ME_TE_1:
		infos := make([]asdu.MeasuredValueScaledInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.MeasuredValueScaledInfo))
		}
		return asdu.MeasuredValueScaledCP56Time2a(c, coa, ca, infos...)
	case asdu.M_ME_NC_1:
		infos := make([]asdu.MeasuredValueFloatInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.MeasuredValueFloatInfo))
		}
		return asdu.MeasuredValueFloat(c, false, coa, ca, infos...)
	case asdu.M_ME_TF_1:
		infos := make([]asdu.MeasuredValueFloatInfo, 0, len(objs))
		for _, o := range objs {
			infos = append(infos, o.Info.(asdu.MeasuredValueFloatInfo))
		}
		return asdu.MeasuredValueFloatCP56Time2a(c, coa, ca, infos...)
	}
	return fmt.Errorf("SendInfoBatch: unsupported TypeID %d", typeID)
}

// SendCommand sends one control-direction information object built by
// BuildInfoObj with the given cause of transmission.
func SendCommand(c asdu.Connect, coa asdu.CauseOfTransmission, ca asdu.CommonAddr, obj *InfoObject) error {
	switch obj.TypeID {
	case asdu.C_SC_NA_1, asdu.C_SC_TA_1:
		return asdu.SingleCmd(c, obj.TypeID, coa, ca, obj.Info.(asdu.SingleCommandInfo))
	case asdu.C_DC_NA_1, asdu.C_DC_TA_1:
		return asdu.DoubleCmd(c, obj.TypeID, coa, ca, obj.Info.(asdu.DoubleCommandInfo))
	case asdu.C_RC_NA_1, asdu.C_RC_TA_1:
		return asdu.StepCmd(c, obj.TypeID, coa, ca, obj.Info.(asdu.StepCommandInfo))
	case asdu.C_SE_NA_1, asdu.C_SE_TA_1:
		return asdu.SetpointCmdNormal(c, obj.TypeID, coa, ca, obj.Info.(asdu.SetpointCommandNormalInfo))
	case asdu.C_SE_NB_1, asdu.C_SE_TB_1:
		return asdu.SetpointCmdScaled(c, obj.TypeID, coa, ca, obj.Info.(asdu.SetpointCommandScaledInfo))
	case asdu.C_SE_NC_1, asdu.C_SE_TC_1:
		return asdu.SetpointCmdFloat(c, obj.TypeID, coa, ca, obj.Info.(asdu.SetpointCommandFloatInfo))
	case asdu.C_BO_NA_1, asdu.C_BO_TA_1:
		return asdu.BitsString32Cmd(c, obj.TypeID, coa, ca, obj.Info.(asdu.BitsString32CommandInfo))
	case asdu.C_IC_NA_1:
		return asdu.InterrogationCmd(c, coa, ca, asdu.QualifierOfInterrogation(obj.Qualifier))
	case asdu.C_CI_NA_1:
		return asdu.CounterInterrogationCmd(c, coa, ca, asdu.ParseQualifierCountCall(byte(obj.Qualifier)))
	case asdu.C_RD_NA_1:
		return asdu.ReadCmd(c, coa, ca, asdu.InfoObjAddr(obj.Ioa))
	case asdu.C_CS_NA_1:
		return asdu.ClockSynchronizationCmd(c, coa, ca, obj.Time)
	case asdu.C_RP_NA_1:
		return asdu.ResetProcessCmd(c, coa, ca, asdu.QualifierOfResetProcessCmd(obj.Qualifier))
	case asdu.C_TS_TA_1:
		return asdu.TestCommandCP56Time2a(c, coa, ca, obj.Time)
	case asdu.P_ME_NA_1:
		return asdu.ParameterNormal(c, coa, ca, obj.Info.(asdu.ParameterNormalInfo))
	case asdu.P_ME_NB_1:
		return asdu.ParameterScaled(c, coa, ca, obj.Info.(asdu.ParameterScaledInfo))
	case asdu.P_ME_NC_1:
		return asdu.ParameterFloat(c, coa, ca, obj.Info.(asdu.ParameterFloatInfo))
	case asdu.P_AC_NA_1:
		return asdu.ParameterActivation(c, coa, ca, obj.Info.(asdu.ParameterActivationInfo))
	}
	return fmt.Errorf("SendCommand: unsupported TypeID %d", obj.TypeID)
}
