/*
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

// Logger with the same level scheme and line format as simple-logger.js
// ("<ISO timestamp> - <message>"), written through a dedicated goroutine so
// that logging never blocks the change stream processing path.

package main

import (
	"bufio"
	"fmt"
	"os"
	"sync/atomic"
	"time"
)

// Log levels, same meaning as in simple-logger.js.
const (
	LogLevelMin      = 0
	LogLevelNormal   = 1
	LogLevelDetailed = 2
	LogLevelDebug    = 3
)

var logLevelCurrent atomic.Int32

func setLogLevel(l int) { logLevelCurrent.Store(int32(l)) }
func logLevel() int     { return int(logLevelCurrent.Load()) }

// logChan decouples the producers from the (blocking) write to stdout. A
// dropped line is preferable to a stalled change stream, so the channel is
// buffered and overflow is counted instead of blocking.
var logChan = make(chan string, 8192)
var logDropped atomic.Int64

func init() {
	setLogLevel(LogLevelNormal)
	go logWriter()
}

func logWriter() {
	w := bufio.NewWriterSize(os.Stdout, 64*1024)
	flush := time.NewTicker(200 * time.Millisecond)
	defer flush.Stop()
	for {
		select {
		case line := <-logChan:
			w.WriteString(line)
			w.WriteByte('\n')
			// Drain whatever else is queued before yielding to the ticker.
			for drained := 0; drained < 4096; drained++ {
				select {
				case l2 := <-logChan:
					w.WriteString(l2)
					w.WriteByte('\n')
				default:
					drained = 4096
				}
			}
		case <-flush.C:
			if n := logDropped.Swap(0); n > 0 {
				fmt.Fprintf(w, "%s - Log lines dropped: %d\n", nowISO(), n)
			}
			w.Flush()
		}
	}
}

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

// Log emits a message when its level is at or below the configured level.
func Log(level int, format string, a ...any) {
	if level > logLevel() {
		return
	}
	var msg string
	if len(a) == 0 {
		msg = format
	} else {
		msg = fmt.Sprintf(format, a...)
	}
	select {
	case logChan <- nowISO() + " - " + msg:
	default:
		logDropped.Add(1)
	}
}
