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

import com.mongodb.client.MongoClient;
import com.mongodb.client.MongoClients;
import com.mongodb.client.MongoCollection;
import com.mongodb.client.MongoDatabase;
import org.bson.Document;

/** MongoDB connection with the same TLS connection-string handling as the Go driver. */
public class MongoConnector implements AutoCloseable {
  public final MongoClient client;
  public final MongoCollection<Document> rtData;
  public final MongoCollection<Document> instances;
  public final MongoCollection<Document> connections;
  public final MongoCollection<Document> commands;

  private MongoConnector(MongoClient client, MongoDatabase db) {
    this.client = client;
    this.rtData = db.getCollection("realtimeData");
    this.instances = db.getCollection("protocolDriverInstances");
    this.connections = db.getCollection("protocolConnections");
    this.commands = db.getCollection("commandsQueue");
  }

  public static MongoConnector connect(ConfigData cfg) {
    String connStr = cfg.mongoConnectionString;
    if (!cfg.tlsCaPemFile.isEmpty() || !cfg.tlsClientPemFile.isEmpty()) {
      connStr += "&tls=true";
    }
    if (!cfg.tlsCaPemFile.isEmpty()) {
      connStr += "&tlsCAFile=" + cfg.tlsCaPemFile;
    }
    if (!cfg.tlsClientPemFile.isEmpty()) {
      connStr += "&tlsCertificateKeyFile=" + cfg.tlsClientPemFile;
    }
    if (!cfg.tlsClientKeyPassword.isEmpty()) {
      connStr += "&tlsCertificateKeyFilePassword=" + cfg.tlsClientKeyPassword;
    }
    if (cfg.tlsInsecure || cfg.tlsAllowChainErrors) {
      connStr += "&tlsInsecure=true";
    }
    if (cfg.tlsAllowInvalidHostnames) {
      connStr += "&tlsAllowInvalidHostnames=true";
    }

    MongoClient client = MongoClients.create(connStr);
    MongoDatabase db = client.getDatabase(cfg.mongoDatabaseName);
    // fail fast if the server is unreachable (like the Go ping with timeout)
    db.runCommand(new Document("ping", 1));
    return new MongoConnector(client, db);
  }

  @Override
  public void close() {
    try {
      client.close();
    } catch (Exception e) {
      // ignore errors on close
    }
  }
}
