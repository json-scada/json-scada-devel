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

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parses connection "topics" entries: "TAG_NAME|PLC4X_ADDRESS|ENDIANNESS"
 * (2nd and 3rd parts optional). Same conventions as the Go plc4x-client.
 */
public final class TopicParser {

  private static final Pattern ARRAY_PATTERN = Pattern.compile("\\[(.*?)\\]");

  public static class ParsedTopic {
    public String jsTagName = "";
    public String address = "";
    public String endianness = "";
    public int arrayLength = 0; // 0 = not an array address
    public String jsType = "analog";
  }

  private TopicParser() {}

  public static ParsedTopic parse(String topic, String addrSeparator) {
    ParsedTopic pt = new ParsedTopic();
    String[] parts = topic.split("\\|");
    if (parts.length > 2) {
      pt.jsTagName = parts[0];
      pt.address = parts[1];
      pt.endianness = parts[2].toUpperCase(Locale.ROOT).trim();
    } else if (parts.length > 1) {
      pt.jsTagName = parts[0];
      pt.address = parts[1];
    } else {
      pt.address = topic;
    }
    pt.jsType = inferType(pt.address, addrSeparator);
    Matcher m = ARRAY_PATTERN.matcher(pt.address);
    if (m.find()) {
      try {
        pt.arrayLength = Integer.parseInt(m.group(1));
      } catch (NumberFormatException e) {
        pt.arrayLength = -1; // unparseable array size
      }
    }
    return pt;
  }

  /**
   * JSON-SCADA tag type inferred from the data type inside the PLC4X address.
   * (The Go driver compares the uppercased address against mixed-case "Struct",
   * which never matches — fixed here by uppercasing both sides.)
   */
  public static String inferType(String address, String addrSeparator) {
    String addr = address.toUpperCase(Locale.ROOT);
    if (addr.contains(addrSeparator + "BOOL")) {
      return "digital";
    }
    if (addr.contains(addrSeparator + "STRING") || addr.contains(addrSeparator + "CHAR")) {
      return "string";
    }
    if (addr.contains(addrSeparator + "STRUCT")
        || addr.contains(addrSeparator + "LIST")
        || addr.contains(addrSeparator + "RAW_BYTE_ARRAY")) {
      return "json";
    }
    return "analog";
  }

  /** Address separator used for data-type detection, by URL scheme. */
  public static String addrSeparatorForScheme(String scheme) {
    switch (scheme) {
      case "knxnet-ip":
        return "/";
      case "opcua":
        return ";";
      default:
        return ":";
    }
  }
}
