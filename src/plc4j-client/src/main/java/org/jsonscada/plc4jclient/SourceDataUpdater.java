/*
 * PLC4J Client - Generic PLC Protocol driver for {json:scada}
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

package org.jsonscada.plc4jclient;

import com.mongodb.client.model.UpdateManyModel;
import com.mongodb.client.model.WriteModel;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import org.bson.Document;

/**
 * Builds the realtimeData sourceDataUpdate operations, with the exact document
 * shape written by the Go plc4x-client.
 */
public final class SourceDataUpdater {

  private SourceDataUpdater() {}

  public static void appendOps(
      List<WriteModel<Document>> ops,
      ProtocolConnection pc,
      String plc4xTagName,
      String asduAtSource,
      ExtractedValue ev) {

    if (ev.valArrDbl.size() > 1) {
      // one update per array element, object address = "ADDR[i]"
      for (int i = 0; i < ev.valArrDbl.size(); i++) {
        double elem = ev.valArrDbl.get(i);
        String valStr = String.format(Locale.US, "%f", elem);
        Document sdu = new Document()
            .append("valueAtSource", elem)
            .append("valueStringAtSource", valStr)
            .append("valueJsonAtSource", valStr)
            .append("invalidAtSource", ev.bad)
            .append("notTopicalAtSource", false)
            .append("substitutedAtSource", false)
            .append("blockedAtSource", false)
            .append("overflowAtSource", false)
            .append("transientAtSource", false)
            .append("carryAtSource", false)
            .append("asduAtSource", asduAtSource)
            .append("causeOfTransmissionAtSource", 20)
            .append("timeTag", new Date());
        Document filter = new Document()
            .append("protocolSourceConnectionNumber", pc.protocolConnectionNumber)
            .append("protocolSourceObjectAddress", plc4xTagName + "[" + i + "]");
        ops.add(new UpdateManyModel<>(filter, new Document("$set",
            new Document("sourceDataUpdate", sdu))));
      }
      return;
    }

    Document valBson = null;
    if (ev.valJson != null && ev.valJson.trim().startsWith("{")) {
      try {
        valBson = Document.parse(ev.valJson);
      } catch (Exception e) {
        // tolerate unparseable JSON (parity with Go bson.Unmarshal best effort)
      }
    }
    Document sdu = new Document()
        .append("valueAtSource", ev.valDbl)
        .append("valueStringAtSource", ev.valStr)
        .append("valueJsonAtSource", ev.valJson)
        .append("valueBsonAtSource", valBson)
        .append("invalidAtSource", ev.bad)
        .append("notTopicalAtSource", false)
        .append("substitutedAtSource", false)
        .append("blockedAtSource", false)
        .append("overflowAtSource", false)
        .append("transientAtSource", false)
        .append("carryAtSource", false)
        .append("asduAtSource", asduAtSource)
        .append("causeOfTransmissionAtSource", 20)
        .append("timeTag", new Date());
    Document filter = new Document()
        .append("protocolSourceConnectionNumber", pc.protocolConnectionNumber)
        .append("protocolSourceObjectAddress", plc4xTagName);
    ops.add(new UpdateManyModel<>(filter, new Document("$set",
        new Document("sourceDataUpdate", sdu))));
  }
}
