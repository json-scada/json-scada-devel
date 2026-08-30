/*
 * DNP3 Outstation Server Protocol driver for {json:scada}, in Go.
 * {json:scada} - Copyright (c) 2020-2026 - Ricardo L. Olsen
 * This file is part of the JSON-SCADA distribution (https://github.com/riclolsen/json-scada).
 *
 * A drop-in alternative to the C++ driver of src/dnp3/Dnp3Server: same protocol
 * driver name, same configuration documents, same MongoDB semantics, with no
 * opendnp3, mongo-cxx-driver or OpenSSL build.
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

package main

import (
	"os"

	"dnp3-go/internal/jscfg"
	"dnp3-go/internal/serverapp"
)

// The server's own fallback, as in Dnp3Server.
const altConfigFilePath = "/json-scada/conf/json-scada.json"

func main() {
	jscfg.Log(jscfg.LogLevelNoLog, "%s", serverapp.DriverMessage)
	jscfg.Log(jscfg.LogLevelNoLog, "Driver version: %s", serverapp.DriverVersion)
	jscfg.Log(jscfg.LogLevelNoLog,
		"Usage: %s [ProtocolDriverInstanceNumber] [LogLevel] [ConfigurationFile]", os.Args[0])

	args := jscfg.ParseArgs(os.Args)
	jscfg.Log(jscfg.LogLevelNoLog, "ProtocolDriverInstanceNumber: %d", args.InstanceNumber)
	jscfg.Log(jscfg.LogLevelNoLog, "LogLevel: %d", jscfg.GetLogLevel())

	cfg, path, err := jscfg.LoadConfig(args.ConfigFilePath, altConfigFilePath)
	if err != nil {
		jscfg.Fatal("Could not open the configuration file: %s - %v", path, err)
	}
	jscfg.Log(jscfg.LogLevelNoLog, "ConfigurationFile: %s", path)

	if cfg.MongoConnectionString == "" || cfg.MongoDatabaseName == "" {
		jscfg.Fatal("MongoDB connection string or database name is empty in %s", path)
	}

	serverapp.Run(args, cfg)
}
