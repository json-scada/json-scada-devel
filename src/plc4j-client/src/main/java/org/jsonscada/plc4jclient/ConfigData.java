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

/** Contents of the JSON-SCADA config file (conf/json-scada.json). */
public class ConfigData {
  public String nodeName = "";
  public String mongoConnectionString = "";
  public String mongoDatabaseName = "";
  public String tlsCaPemFile = "";
  public String tlsClientPemFile = "";
  public String tlsClientPfxFile = "";
  public String tlsClientKeyPassword = "";
  public boolean tlsAllowInvalidHostnames = false;
  public boolean tlsAllowChainErrors = false;
  public boolean tlsInsecure = false;
}
