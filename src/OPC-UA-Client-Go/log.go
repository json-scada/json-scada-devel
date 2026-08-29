/*
 * OPC-UA Client Protocol driver for {json:scada}, in Go.
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

// Logging. Port of the Log() helpers of Common_srv_cli.cs.

package main

import (
	"bufio"
	"fmt"
	"os"
	"sync"
	"time"
)

// Log levels, same numbering as the C# driver and the instance document.
const (
	LogLevelNoLog    = 0
	LogLevelBasic    = 1
	LogLevelDetailed = 2
	LogLevelDebug    = 3
)

// LogLevel is the effective verbosity.
//
// parity: the C# driver sets it from the command line only — it reads
// logLevel into the instance document type but never assigns it to
// MainClass.LogLevel. Do the same, so both binaries answer to the same
// knob.
var LogLevel = LogLevelBasic

var (
	logMutex  sync.Mutex
	logWriter = bufio.NewWriterSize(os.Stdout, 32*1024)
	logDirty  bool
)

func init() {
	// Flush the buffered writer regularly so a service log stays live
	// without paying a syscall per line during notification bursts.
	go func() {
		t := time.NewTicker(200 * time.Millisecond)
		for range t.C {
			logMutex.Lock()
			if logDirty {
				_ = logWriter.Flush()
				logDirty = false
			}
			logMutex.Unlock()
		}
	}()
}

// Log writes one line prefixed with the timestamp, in the same shape the C#
// driver uses: [2022-01-13T16:25:35.1250000+06:00] message
func Log(level int, format string, a ...any) {
	if LogLevel < level {
		return
	}
	msg := format
	if len(a) > 0 {
		msg = fmt.Sprintf(format, a...)
	}
	// Same shape as .NET's "o" round-trip format: seven fractional digits,
	// always present, with the local UTC offset.
	now := time.Now().Format("2006-01-02T15:04:05.0000000Z07:00")
	logMutex.Lock()
	fmt.Fprintf(logWriter, "[%s] %s\n", now, msg)
	logDirty = true
	logMutex.Unlock()
}

// LogFlush drains the buffered writer; used before exiting.
func LogFlush() {
	logMutex.Lock()
	_ = logWriter.Flush()
	logDirty = false
	logMutex.Unlock()
}

// Fatal logs and terminates with the C# driver's exit code for a
// configuration error (Environment.Exit(-1)).
func Fatal(format string, a ...any) {
	Log(LogLevelNoLog, format, a...)
	LogFlush()
	os.Exit(-1)
}
