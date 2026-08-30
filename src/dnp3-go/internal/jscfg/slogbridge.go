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

// Bridges the DNP3 stack's *slog.Logger onto the driver's own logger, so both
// streams share one mutex and one timestamp format and cannot interleave
// mid-line. Replaces the DNP3LogBridge : ILogHandler of the C++ client.

package jscfg

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
)

// The library logs protocol traffic at Debug and session milestones at Info.
// The mapping mirrors mapLogLevel() of the C++ client: warnings and errors are
// visible at the basic level, session events from detailed, traffic only at
// debug.
func driverLevelFor(level slog.Level) int {
	switch {
	case level >= slog.LevelWarn:
		return LogLevelBasic
	case level >= slog.LevelInfo:
		return LogLevelDetailed
	default:
		return LogLevelDebug
	}
}

type slogHandler struct {
	prefix string
	attrs  []slog.Attr
	groups []string
}

// NewStackLogger returns the *slog.Logger to hand to master.Config.Log or
// outstation.Config.Log. prefix is normally the connection name, so a line
// from the stack reads like a line from the driver.
func NewStackLogger(prefix string) *slog.Logger {
	return slog.New(&slogHandler{prefix: prefix})
}

func (h *slogHandler) Enabled(_ context.Context, level slog.Level) bool {
	return GetLogLevel() >= driverLevelFor(level)
}

func (h *slogHandler) Handle(_ context.Context, r slog.Record) error {
	var b strings.Builder
	if h.prefix != "" {
		b.WriteString(h.prefix)
		b.WriteString(" - ")
	}
	b.WriteString(r.Message)
	for _, a := range h.attrs {
		appendAttr(&b, h.groups, a)
	}
	r.Attrs(func(a slog.Attr) bool {
		appendAttr(&b, h.groups, a)
		return true
	})
	Log(driverLevelFor(r.Level), "%s", b.String())
	return nil
}

func appendAttr(b *strings.Builder, groups []string, a slog.Attr) {
	if a.Equal(slog.Attr{}) {
		return
	}
	if a.Value.Kind() == slog.KindGroup {
		for _, sub := range a.Value.Group() {
			appendAttr(b, append(groups, a.Key), sub)
		}
		return
	}
	b.WriteByte(' ')
	for _, g := range groups {
		b.WriteString(g)
		b.WriteByte('.')
	}
	b.WriteString(a.Key)
	b.WriteByte('=')
	fmt.Fprintf(b, "%v", a.Value.Resolve().Any())
}

func (h *slogHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return h
	}
	n := *h
	n.attrs = append(append([]slog.Attr(nil), h.attrs...), attrs...)
	return &n
}

func (h *slogHandler) WithGroup(name string) slog.Handler {
	if name == "" {
		return h
	}
	n := *h
	n.groups = append(append([]string(nil), h.groups...), name)
	return &n
}
