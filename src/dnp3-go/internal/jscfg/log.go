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

// Levelled logging. Port of the Logger class of the C++ drivers.

package jscfg

import (
	"bufio"
	"fmt"
	"os"
	"sync"
	"time"
)

// Log levels, same numbering as the C++ drivers and the instance document.
const (
	LogLevelNoLog    = 0
	LogLevelBasic    = 1
	LogLevelDetailed = 2
	LogLevelDebug    = 3
)

var (
	logLevel  = LogLevelBasic
	logMutex  sync.Mutex
	logWriter = bufio.NewWriterSize(os.Stdout, 32*1024)
	logDirty  bool
)

func init() {
	// Flush regularly so a log under a service manager stays live without
	// paying a syscall per line during a burst of data.
	go func() {
		t := time.NewTicker(200 * time.Millisecond)
		for range t.C {
			LogFlush()
		}
	}()
}

// SetLogLevel sets the effective verbosity.
func SetLogLevel(level int) {
	logMutex.Lock()
	logLevel = level
	logMutex.Unlock()
}

// GetLogLevel returns the effective verbosity.
func GetLogLevel() int {
	logMutex.Lock()
	defer logMutex.Unlock()
	return logLevel
}

// Log writes one line prefixed with a timestamp, in the shape the C++ drivers
// use: [2025-01-13T16:25:35.125-03:00] message
func Log(level int, format string, a ...any) {
	logMutex.Lock()
	if logLevel < level {
		logMutex.Unlock()
		return
	}
	msg := format
	if len(a) > 0 {
		msg = fmt.Sprintf(format, a...)
	}
	// The C++ server prints milliseconds and the local UTC offset; the C++
	// client omits the offset. Both are accepted by every consumer of these
	// logs, so the richer form is used for both drivers.
	now := time.Now().Format("2006-01-02T15:04:05.000Z07:00")
	fmt.Fprintf(logWriter, "[%s] %s\n", now, msg)
	logDirty = true
	logMutex.Unlock()
}

// LogFlush drains the buffered writer; used before exiting.
func LogFlush() {
	logMutex.Lock()
	if logDirty {
		_ = logWriter.Flush()
		logDirty = false
	}
	logMutex.Unlock()
}

// Fatal logs and terminates with the exit code the C++ drivers use for a
// configuration error.
func Fatal(format string, a ...any) {
	Log(LogLevelNoLog, format, a...)
	LogFlush()
	os.Exit(-1)
}
