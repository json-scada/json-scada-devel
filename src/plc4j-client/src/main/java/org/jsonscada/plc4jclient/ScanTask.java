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

import com.mongodb.client.model.WriteModel;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.apache.plc4x.java.api.PlcConnection;
import org.apache.plc4x.java.api.messages.PlcReadRequest;
import org.apache.plc4x.java.api.messages.PlcReadResponse;
import org.apache.plc4x.java.api.types.PlcResponseCode;
import org.apache.plc4x.java.api.value.PlcValue;

/**
 * Periodic integrity read of all topics of one connection (like the per-connection
 * goroutine in the Go driver): immediate read after connect, then every giInterval
 * seconds; exits closing the connection when the instance goes inactive or the
 * device stops answering (the supervision loop reconnects).
 */
public class ScanTask implements Runnable {

  private final ProtocolConnection pc;
  private final MongoWriter writer;

  public ScanTask(ProtocolConnection pc, MongoWriter writer) {
    this.pc = pc;
    this.writer = writer;
  }

  @Override
  public void run() {
    execRead();
    long periodMs = pc.giInterval > 0 ? (long) (pc.giInterval * 1000) : 300_000L;
    if (pc.giInterval <= 0) {
      Log.log(pc.name + ": giInterval not set, defaulting to 300s");
    }
    while (true) {
      RedundancyManager.sleepMs(periodMs);
      PlcConnection conn = pc.plcConn;
      if (conn == null || !conn.isConnected()) {
        break;
      }
      if (!RedundancyManager.isActive) {
        Log.log("Instance inactive! Closing connection...");
        pc.closeQuietly();
        break;
      }
      if (execRead()) {
        continue;
      }
      if (!Plc4jClient.pingOk(pc)) {
        pc.closeQuietly();
        break;
      }
    }
  }

  /** Executes the integrity read; returns false on read failure. */
  boolean execRead() {
    PlcReadRequest req = pc.readRequest;
    if (req == null) {
      return false;
    }
    if (Log.level >= Log.LEVEL_BASIC) {
      Log.log(pc.name + ": integrity read...");
    }
    PlcReadResponse resp;
    try {
      long timeoutS = Math.max(5, Math.min(60, (long) pc.giInterval));
      resp = req.execute().get(timeoutS, TimeUnit.SECONDS);
    } catch (Exception e) {
      Log.log(pc.name + ": error executing read-request: "
          + (e.getMessage() != null ? e.getMessage() : e.toString()));
      return false;
    }

    List<WriteModel<org.bson.Document>> ops = new ArrayList<>();
    for (String tagName : resp.getTagNames()) {
      PlcResponseCode rc = null;
      try {
        rc = resp.getResponseCode(tagName);
      } catch (Exception e) {
        // tolerate drivers without per-tag response codes
      }
      PlcValue v = null;
      if (rc == null || rc == PlcResponseCode.OK) {
        try {
          v = resp.getPlcValue(tagName);
        } catch (Exception e) {
          // value extraction below will mark it bad
        }
      }
      ExtractedValue ev;
      String asduAtSource;
      if (v == null) {
        ev = ExtractedValue.ofBad();
        asduAtSource = rc != null ? rc.name() : "ERROR";
        if (Log.level >= Log.LEVEL_DETAILED) {
          Log.log(pc.name + ": Read result '" + tagName + "': response code " + asduAtSource);
        }
      } else {
        String endianness = pc.endiannessByTag.getOrDefault(tagName, "");
        ev = ValueExtractor.extract(v, endianness, pc.name, tagName);
        asduAtSource = v.getPlcValueType() != null ? v.getPlcValueType().name() : "Unknown";
      }
      SourceDataUpdater.appendOps(ops, pc, tagName, asduAtSource, ev);
    }
    if (!ops.isEmpty() && !writer.queue.offer(ops)) {
      System.out.println("Error: mongo write channel full. Discarding values!");
    }
    return true;
  }
}
