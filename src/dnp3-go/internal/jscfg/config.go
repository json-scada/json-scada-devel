/*
 * DNP3 Client and Server Protocol drivers for {json:scada}, in Go.
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

// The json-scada.json configuration file and the command line arguments both
// drivers accept.

package jscfg

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
)

// Collection names.
const (
	ProtocolConnectionsCollectionName     = "protocolConnections"
	ProtocolDriverInstancesCollectionName = "protocolDriverInstances"
	RealtimeDataCollectionName            = "realtimeData"
	CommandsQueueCollectionName           = "commandsQueue"
)

// DefaultConfigFilePath is the path both C++ drivers try first.
const DefaultConfigFilePath = "../conf/json-scada.json"

// Config is the subset of json-scada.json the drivers use.
type Config struct {
	NodeName              string `json:"nodeName"`
	MongoConnectionString string `json:"mongoConnectionString"`
	MongoDatabaseName     string `json:"mongoDatabaseName"`
}

// Args is the parsed command line: <instance> <logLevel> <configFile>, all
// optional, in that order.
type Args struct {
	InstanceNumber int
	ConfigFilePath string
	// LogLevelFromCLI records whether the log level was given on the command
	// line. The C++ client keeps a command-line level in preference to the one
	// in the instance document; both Go drivers do the same.
	LogLevelFromCLI bool
}

// ParseArgs reads the three positional arguments and applies a log level given
// on the command line immediately, so that anything logged during startup
// already honours it.
func ParseArgs(argv []string) Args {
	args := Args{InstanceNumber: 1, ConfigFilePath: DefaultConfigFilePath}

	if len(argv) > 1 && argv[1] != "" {
		if n, err := strconv.Atoi(argv[1]); err == nil {
			args.InstanceNumber = n
		} else {
			Log(LogLevelNoLog, "Conversion error: Invalid integer value for ProtocolDriverInstanceNumber")
		}
	}
	if len(argv) > 2 && argv[2] != "" {
		if n, err := strconv.Atoi(argv[2]); err == nil {
			SetLogLevel(n)
			args.LogLevelFromCLI = true
		} else {
			Log(LogLevelNoLog, "Conversion error: Invalid integer value for LogLevel")
		}
	}
	if len(argv) > 3 && argv[3] != "" {
		args.ConfigFilePath = argv[3]
	}
	return args
}

// ResolvePath expands a leading ~/ using HOME, then USERPROFILE.
func ResolvePath(path string) string {
	if !strings.HasPrefix(path, "~/") {
		return path
	}
	home := os.Getenv("HOME")
	if home == "" {
		home = os.Getenv("USERPROFILE")
	}
	if home == "" {
		return path
	}
	return home + path[1:]
}

// FileExists reports whether the path can be opened for reading.
func FileExists(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

// LoadConfig reads json-scada.json, trying fallback when path does not exist.
//
// The two C++ drivers use different fallbacks — the client
// ~/json-scada/conf/json-scada.json, the server /json-scada/conf/json-scada.json
// — so each Go driver passes its own and neither changes behaviour.
func LoadConfig(path, fallback string) (Config, string, error) {
	resolved := ResolvePath(path)
	if !FileExists(resolved) && fallback != "" {
		resolved = ResolvePath(fallback)
	}
	data, err := os.ReadFile(resolved)
	if err != nil {
		return Config{}, resolved, err
	}
	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return Config{}, resolved, err
	}
	return cfg, resolved, nil
}
