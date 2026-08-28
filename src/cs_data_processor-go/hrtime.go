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

// High resolution monotonic clock for the latency instrumentation.
//
// On Windows the monotonic clock behind time.Now() ticks at the system timer
// granularity (typically 0.5 ms), which is coarser than the stages measured
// here and would quantize them to zero. hrNow reads the performance counter
// directly there; elsewhere time.Now() already has nanosecond resolution.
//
// Only the short, in-process stages use this clock. Stages measured against a
// timestamp written by another process (sourceToRecv, endToEnd) must stay on
// the wall clock, where the granularity is negligible against tens of
// milliseconds.

package main

import "time"

// hrTime is an instant of the high resolution monotonic clock, in nanoseconds
// from an unspecified origin.
type hrTime int64

func hrNow() hrTime { return hrTime(hrNowNanos()) }

// since returns the time elapsed since t.
func (t hrTime) since() time.Duration { return time.Duration(hrNowNanos() - int64(t)) }

// hrSub returns a - b.
func hrSub(a, b hrTime) time.Duration { return time.Duration(a - b) }
