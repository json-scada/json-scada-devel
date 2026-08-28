/*
 * IEC 60870-5-101/104 protocol drivers for {json:scada} - shared configuration
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

package jscfg

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Log levels (same numbering as the C# drivers).
const (
	LogLevelNoLog    = 0
	LogLevelBasic    = 1
	LogLevelDetailed = 2
	LogLevelDebug    = 3
)

var (
	logLevel = LogLevelBasic
	logMutex sync.Mutex
)

// SetLogLevel sets the global log level.
func SetLogLevel(level int) { logLevel = level }

// LogLevel returns the global log level.
func LogLevel() int { return logLevel }

// Log writes a timestamped message to stdout when the global level admits it.
func Log(level int, msg string) {
	if logLevel >= level {
		logMutex.Lock()
		fmt.Printf("[%s] %s\n", time.Now().Format(time.RFC3339Nano), msg)
		logMutex.Unlock()
	}
}

// Logf is Log with formatting.
func Logf(level int, format string, args ...interface{}) {
	if logLevel >= level {
		Log(level, fmt.Sprintf(format, args...))
	}
}

// Config is the base configuration of the system (conf/json-scada.json).
type Config struct {
	NodeName                 string `json:"nodeName"`
	MongoConnectionString    string `json:"mongoConnectionString"`
	MongoDatabaseName        string `json:"mongoDatabaseName"`
	TLSCaPemFile             string `json:"tlsCaPemFile"`
	TLSClientPemFile         string `json:"tlsClientPemFile"`
	TLSClientPfxFile         string `json:"tlsClientPfxFile"`
	TLSClientKeyPassword     string `json:"tlsClientKeyPassword"`
	TLSAllowInvalidHostnames bool   `json:"tlsAllowInvalidHostnames"`
	TLSAllowChainErrors      bool   `json:"tlsAllowChainErrors"`
	TLSInsecure              bool   `json:"tlsInsecure"`
}

// Read parses CLI args (instance number, log level, config file path — same
// contract as the C# drivers) and loads the json-scada config file.
func Read() (cfg Config, instanceNumber int, err error) {
	instanceNumber = 1
	if len(os.Args) > 1 {
		i, cerr := strconv.Atoi(os.Args[1])
		if cerr != nil {
			return cfg, 0, fmt.Errorf("instance parameter should be a number: %v", cerr)
		}
		instanceNumber = i
	}
	if len(os.Args) > 2 {
		i, cerr := strconv.Atoi(os.Args[2])
		if cerr != nil {
			return cfg, 0, fmt.Errorf("log level parameter should be a number: %v", cerr)
		}
		logLevel = i
	}

	cfgFileName := filepath.Join("..", "conf", "json-scada.json")
	if _, serr := os.Stat(cfgFileName); serr != nil {
		cfgFileName = filepath.Join("c:\\", "json-scada", "conf", "json-scada.json")
	}
	if os.Getenv("JS_CONFIG_FILE") != "" {
		cfgFileName = os.Getenv("JS_CONFIG_FILE")
	}
	if len(os.Args) > 3 {
		if _, serr := os.Stat(os.Args[3]); serr == nil {
			cfgFileName = os.Args[3]
		}
	}

	Log(LogLevelBasic, "Reading config file "+cfgFileName)
	data, err := os.ReadFile(cfgFileName)
	if err != nil {
		return cfg, 0, fmt.Errorf("failed to read config file: %v", err)
	}
	if err = json.Unmarshal(data, &cfg); err != nil {
		return cfg, 0, fmt.Errorf("failed to parse config file JSON: %v", err)
	}
	cfg.MongoConnectionString = strings.TrimSpace(cfg.MongoConnectionString)
	cfg.MongoDatabaseName = strings.TrimSpace(cfg.MongoDatabaseName)
	cfg.NodeName = strings.TrimSpace(cfg.NodeName)
	if cfg.MongoConnectionString == "" {
		return cfg, 0, fmt.Errorf("missing MongoDB connection string in config file")
	}
	if cfg.MongoDatabaseName == "" {
		return cfg, 0, fmt.Errorf("missing MongoDB database name in config file")
	}
	if cfg.NodeName == "" {
		return cfg, 0, fmt.Errorf("missing nodeName parameter in config file")
	}
	return cfg, instanceNumber, nil
}
