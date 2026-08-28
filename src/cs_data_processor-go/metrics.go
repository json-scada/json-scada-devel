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

// Latency instrumentation.
//
// The stage names, the counter names and the JSON layout produced here are
// identical to the ones produced by metrics.js in the Node.js implementation,
// so a snapshot taken from either process can be compared field by field
// (see tools/compare-latency.js).
//
// Samples are recorded into an HDR-style logarithmic histogram of
// microseconds with 64 sub-buckets per octave (worst case bucket error
// ~1.6%), updated with atomic adds so the hot path never takes a lock.

package main

import (
	"encoding/json"
	"fmt"
	"math"
	"math/bits"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Latency stage identifiers. Keep in sync with metrics.js.
const (
	StageSourceToRecv = "sourceToRecv" // driver timestamp -> change event delivered to this process
	StageQueueWait    = "queueWait"    // delivered -> picked up by a processing worker
	StageProcessing   = "processing"   // worker start -> update decided and handed to a writer
	StageWriteLinger  = "writeLinger"  // handed to writer -> included in a flushed batch
	StageBulkWrite    = "bulkWrite"    // duration of the realtimeData bulk write
	StageEndToEnd     = "endToEnd"     // driver timestamp -> realtimeData write completed
	StageSoeWrite     = "soeWrite"     // duration of the soeData batched insert
	StageHistWrite    = "histWrite"    // duration of the hist insert + SQL file write
)

// stageOrder fixes the order stages are reported in, for readable output.
var stageOrder = []string{
	StageSourceToRecv,
	StageQueueWait,
	StageProcessing,
	StageWriteLinger,
	StageBulkWrite,
	StageEndToEnd,
	StageSoeWrite,
	StageHistWrite,
}

// Counter names. Keep in sync with metrics.js.
const (
	CntChangesReceived   = "changesReceived"
	CntChangesProcessed  = "changesProcessed"
	CntInserts           = "inserts"
	CntUpdatesQueued     = "updatesQueued"
	CntNotChanged        = "notChanged"
	CntIgnoredInactive   = "ignoredInactive"
	CntSoeInserted       = "soeInserted"
	CntHistQueued        = "histQueued"
	CntMongoBulkWrites   = "mongoBulkWrites"
	CntMongoDocsWritten  = "mongoDocsWritten"
	CntHistDocsWritten   = "histDocsWritten"
	CntSQLFilesWritten   = "sqlFilesWritten"
	CntErrors            = "errors"
	CntDropped           = "droppedOnBackpressure"
	CntChangeStreamRetry = "changeStreamRetries"
)

var counterOrder = []string{
	CntChangesReceived, CntChangesProcessed, CntInserts, CntUpdatesQueued,
	CntNotChanged, CntIgnoredInactive, CntSoeInserted, CntHistQueued,
	CntMongoBulkWrites, CntMongoDocsWritten, CntHistDocsWritten,
	CntSQLFilesWritten, CntErrors, CntDropped, CntChangeStreamRetry,
}

// ---------------------------------------------------------------------------
// Histogram
// ---------------------------------------------------------------------------

const (
	histSubBucketBits  = 6
	histSubBucketCount = 1 << histSubBucketBits // 64
	histBucketCount    = 4096
)

// Histogram is a lock free logarithmic histogram of microsecond samples.
type Histogram struct {
	buckets [histBucketCount]atomic.Int64
	count   atomic.Int64
	sum     atomic.Int64 // microseconds
	min     atomic.Int64
	max     atomic.Int64
}

// NewHistogram returns an empty histogram.
func NewHistogram() *Histogram {
	h := &Histogram{}
	h.min.Store(math.MaxInt64)
	return h
}

// histIndex maps a microsecond value to its bucket.
func histIndex(v int64) int {
	if v < histSubBucketCount {
		if v < 0 {
			return 0
		}
		return int(v)
	}
	shift := bits.Len64(uint64(v)) - (histSubBucketBits + 1)
	idx := histSubBucketCount*shift + int(uint64(v)>>uint(shift))
	if idx >= histBucketCount {
		idx = histBucketCount - 1
	}
	return idx
}

// histValue returns the representative (mid point) value of a bucket.
func histValue(idx int) float64 {
	if idx < 2*histSubBucketCount {
		return float64(idx)
	}
	shift := idx/histSubBucketCount - 1
	sub := idx%histSubBucketCount + histSubBucketCount
	width := float64(int64(1) << uint(shift))
	return float64(int64(sub)<<uint(shift)) + width/2
}

// Observe records one sample given in microseconds.
func (h *Histogram) Observe(us int64) {
	if us < 0 {
		us = 0
	}
	h.buckets[histIndex(us)].Add(1)
	h.count.Add(1)
	h.sum.Add(us)
	for {
		cur := h.min.Load()
		if us >= cur || h.min.CompareAndSwap(cur, us) {
			break
		}
	}
	for {
		cur := h.max.Load()
		if us <= cur || h.max.CompareAndSwap(cur, us) {
			break
		}
	}
}

// ObserveSince records the time elapsed since t on the wall clock. Use it
// only for stages long enough that the wall clock granularity does not
// matter; short in-process stages must use ObserveHrSince.
func (h *Histogram) ObserveSince(t time.Time) {
	h.Observe(time.Since(t).Microseconds())
}

// ObserveHrSince records the time elapsed since t on the high resolution
// monotonic clock.
func (h *Histogram) ObserveHrSince(t hrTime) {
	h.Observe(t.since().Microseconds())
}

// ObserveDuration records a duration.
func (h *Histogram) ObserveDuration(d time.Duration) {
	h.Observe(d.Microseconds())
}

// Reset clears all samples.
func (h *Histogram) Reset() {
	for i := range h.buckets {
		h.buckets[i].Store(0)
	}
	h.count.Store(0)
	h.sum.Store(0)
	h.min.Store(math.MaxInt64)
	h.max.Store(0)
}

// StageStats is the reported summary of one stage, all values in milliseconds.
type StageStats struct {
	Count float64 `json:"count"`
	MinMs float64 `json:"minMs"`
	MaxMs float64 `json:"maxMs"`
	AvgMs float64 `json:"avgMs"`
	P50Ms float64 `json:"p50Ms"`
	P90Ms float64 `json:"p90Ms"`
	P99Ms float64 `json:"p99Ms"`
	P999  float64 `json:"p999Ms"`
}

// Snapshot summarizes the histogram.
func (h *Histogram) Snapshot() StageStats {
	total := h.count.Load()
	st := StageStats{Count: float64(total)}
	if total == 0 {
		return st
	}
	st.MinMs = float64(h.min.Load()) / 1000
	st.MaxMs = float64(h.max.Load()) / 1000
	st.AvgMs = float64(h.sum.Load()) / float64(total) / 1000

	// snapshot the buckets once, then walk them for the percentiles
	var counts [histBucketCount]int64
	var seen int64
	for i := range h.buckets {
		c := h.buckets[i].Load()
		counts[i] = c
		seen += c
	}
	if seen == 0 {
		return st
	}
	targets := []struct {
		q   float64
		out *float64
	}{
		{0.50, &st.P50Ms}, {0.90, &st.P90Ms}, {0.99, &st.P99Ms}, {0.999, &st.P999},
	}
	ti := 0
	var acc int64
	for i := 0; i < histBucketCount && ti < len(targets); i++ {
		if counts[i] == 0 {
			continue
		}
		acc += counts[i]
		for ti < len(targets) && float64(acc) >= targets[ti].q*float64(seen) {
			*targets[ti].out = histValue(i) / 1000
			ti++
		}
	}
	for ; ti < len(targets); ti++ {
		*targets[ti].out = st.MaxMs
	}
	return st
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// Metrics aggregates every histogram and counter of the process.
type Metrics struct {
	mu         sync.RWMutex
	stages     map[string]*Histogram
	counters   map[string]*atomic.Int64
	startedAt  time.Time
	resetAt    time.Time
	cfg        Config
	extraGauge func() map[string]float64
}

// M is the process wide metrics registry.
var M = newMetrics()

func newMetrics() *Metrics {
	m := &Metrics{
		stages:    make(map[string]*Histogram, len(stageOrder)),
		counters:  make(map[string]*atomic.Int64, len(counterOrder)),
		startedAt: time.Now(),
		resetAt:   time.Now(),
	}
	for _, s := range stageOrder {
		m.stages[s] = NewHistogram()
	}
	for _, c := range counterOrder {
		m.counters[c] = &atomic.Int64{}
	}
	return m
}

// Stage returns the histogram of a stage (never nil).
func (m *Metrics) Stage(name string) *Histogram {
	m.mu.RLock()
	h, ok := m.stages[name]
	m.mu.RUnlock()
	if ok {
		return h
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if h, ok = m.stages[name]; ok {
		return h
	}
	h = NewHistogram()
	m.stages[name] = h
	return h
}

// Inc adds delta to a counter.
func (m *Metrics) Inc(name string, delta int64) {
	m.mu.RLock()
	c, ok := m.counters[name]
	m.mu.RUnlock()
	if !ok {
		m.mu.Lock()
		if c, ok = m.counters[name]; !ok {
			c = &atomic.Int64{}
			m.counters[name] = c
		}
		m.mu.Unlock()
	}
	c.Add(delta)
}

// Get reads a counter.
func (m *Metrics) Get(name string) int64 {
	m.mu.RLock()
	c, ok := m.counters[name]
	m.mu.RUnlock()
	if !ok {
		return 0
	}
	return c.Load()
}

// SetGaugeProvider installs a callback contributing live gauges (queue depths).
func (m *Metrics) SetGaugeProvider(f func() map[string]float64) {
	m.mu.Lock()
	m.extraGauge = f
	m.mu.Unlock()
}

// Reset clears every histogram and counter, keeping the process start time.
func (m *Metrics) Reset() {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, h := range m.stages {
		h.Reset()
	}
	for _, c := range m.counters {
		c.Store(0)
	}
	m.resetAt = time.Now()
}

// MetricsSnapshot is the exchange format shared with the Node.js version.
type MetricsSnapshot struct {
	Implementation string                `json:"implementation"`
	Process        string                `json:"process"`
	Version        string                `json:"version"`
	Instance       int                   `json:"instance"`
	NodeName       string                `json:"nodeName"`
	Active         bool                  `json:"processActive"`
	TimestampISO   string                `json:"timestamp"`
	UptimeSec      float64               `json:"uptimeSec"`
	WindowSec      float64               `json:"windowSec"`
	Counters       map[string]float64    `json:"counters"`
	RatesPerSec    map[string]float64    `json:"ratesPerSec"`
	Gauges         map[string]float64    `json:"gauges"`
	Latency        map[string]StageStats `json:"latencyMs"`
}

// Snapshot builds the current metrics snapshot.
func (m *Metrics) Snapshot() MetricsSnapshot {
	m.mu.RLock()
	cfg := m.cfg
	gaugeFn := m.extraGauge
	resetAt := m.resetAt
	started := m.startedAt
	stages := make(map[string]*Histogram, len(m.stages))
	for k, v := range m.stages {
		stages[k] = v
	}
	counters := make(map[string]*atomic.Int64, len(m.counters))
	for k, v := range m.counters {
		counters[k] = v
	}
	m.mu.RUnlock()

	window := time.Since(resetAt).Seconds()
	if window <= 0 {
		window = 1e-9
	}
	snap := MetricsSnapshot{
		Implementation: AppImplementation,
		Process:        AppName,
		Version:        AppVersion,
		Instance:       cfg.Instance,
		NodeName:       cfg.NodeName,
		Active:         ProcessStateIsActive(),
		TimestampISO:   time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		UptimeSec:      time.Since(started).Seconds(),
		WindowSec:      window,
		Counters:       make(map[string]float64, len(counters)),
		RatesPerSec:    make(map[string]float64, len(counters)),
		Gauges:         map[string]float64{},
		Latency:        make(map[string]StageStats, len(stages)),
	}
	for k, c := range counters {
		v := float64(c.Load())
		snap.Counters[k] = v
		snap.RatesPerSec[k] = v / window
	}
	for k, h := range stages {
		snap.Latency[k] = h.Snapshot()
	}
	if gaugeFn != nil {
		for k, v := range gaugeFn() {
			snap.Gauges[k] = v
		}
	}
	return snap
}

// SetConfig gives the registry access to the identifying config fields.
func (m *Metrics) SetConfig(cfg Config) {
	m.mu.Lock()
	m.cfg = cfg
	m.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

// FormatSummary renders a one line per stage human readable report.
func FormatSummary(s MetricsSnapshot) string {
	var b strings.Builder
	fmt.Fprintf(&b, "METRICS [%s] instance %d active=%v uptime=%.0fs window=%.0fs\n",
		s.Implementation, s.Instance, s.Active, s.UptimeSec, s.WindowSec)
	fmt.Fprintf(&b, "  counters:")
	for _, k := range counterOrder {
		if v, ok := s.Counters[k]; ok && v != 0 {
			fmt.Fprintf(&b, " %s=%.0f", k, v)
		}
	}
	fmt.Fprintf(&b, "\n  throughput: %.1f changes/s, %.1f rt-docs/s\n",
		s.RatesPerSec[CntChangesProcessed], s.RatesPerSec[CntMongoDocsWritten])
	if len(s.Gauges) > 0 {
		keys := make([]string, 0, len(s.Gauges))
		for k := range s.Gauges {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		fmt.Fprintf(&b, "  gauges:")
		for _, k := range keys {
			fmt.Fprintf(&b, " %s=%.0f", k, s.Gauges[k])
		}
		b.WriteByte('\n')
	}
	fmt.Fprintf(&b, "  %-14s %9s %9s %9s %9s %9s %9s %9s\n",
		"stage(ms)", "count", "avg", "p50", "p90", "p99", "p99.9", "max")
	for _, name := range stageOrder {
		st, ok := s.Latency[name]
		if !ok || st.Count == 0 {
			continue
		}
		fmt.Fprintf(&b, "  %-14s %9.0f %9.3f %9.3f %9.3f %9.3f %9.3f %9.3f\n",
			name, st.Count, st.AvgMs, st.P50Ms, st.P90Ms, st.P99Ms, st.P999, st.MaxMs)
	}
	return strings.TrimRight(b.String(), "\n")
}

// FormatPrometheus renders the snapshot in the Prometheus text format.
func FormatPrometheus(s MetricsSnapshot) string {
	var b strings.Builder
	lbl := fmt.Sprintf("{impl=%q,instance=%q,node=%q}", s.Implementation,
		fmt.Sprint(s.Instance), s.NodeName)
	fmt.Fprintf(&b, "# HELP csdp_uptime_seconds Process uptime.\n")
	fmt.Fprintf(&b, "# TYPE csdp_uptime_seconds gauge\ncsdp_uptime_seconds%s %f\n", lbl, s.UptimeSec)
	fmt.Fprintf(&b, "# TYPE csdp_process_active gauge\ncsdp_process_active%s %d\n", lbl, b2i(s.Active))
	keys := make([]string, 0, len(s.Counters))
	for k := range s.Counters {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		fmt.Fprintf(&b, "# TYPE csdp_%s_total counter\ncsdp_%s_total%s %f\n", k, k, lbl, s.Counters[k])
	}
	gk := make([]string, 0, len(s.Gauges))
	for k := range s.Gauges {
		gk = append(gk, k)
	}
	sort.Strings(gk)
	for _, k := range gk {
		fmt.Fprintf(&b, "# TYPE csdp_%s gauge\ncsdp_%s%s %f\n", k, k, lbl, s.Gauges[k])
	}
	for _, name := range stageOrder {
		st, ok := s.Latency[name]
		if !ok {
			continue
		}
		sl := fmt.Sprintf("{impl=%q,instance=%q,node=%q,stage=%q}", s.Implementation,
			fmt.Sprint(s.Instance), s.NodeName, name)
		fmt.Fprintf(&b, "csdp_latency_ms_count%s %f\n", sl, st.Count)
		fmt.Fprintf(&b, "csdp_latency_ms_avg%s %f\n", sl, st.AvgMs)
		for q, v := range map[string]float64{"0.5": st.P50Ms, "0.9": st.P90Ms, "0.99": st.P99Ms, "0.999": st.P999} {
			fmt.Fprintf(&b, "csdp_latency_ms{impl=%q,instance=%q,node=%q,stage=%q,quantile=%q} %f\n",
				s.Implementation, fmt.Sprint(s.Instance), s.NodeName, name, q, v)
		}
		fmt.Fprintf(&b, "csdp_latency_ms_max%s %f\n", sl, st.MaxMs)
	}
	return b.String()
}

func b2i(v bool) int {
	if v {
		return 1
	}
	return 0
}

// StartMetricsReporter starts the periodic log report, the optional metrics
// file dump and the optional HTTP endpoint.
func StartMetricsReporter(cfg Config) {
	M.SetConfig(cfg)

	if cfg.MetricsLogInterval > 0 {
		go func() {
			t := time.NewTicker(cfg.MetricsLogInterval)
			defer t.Stop()
			for range t.C {
				snap := M.Snapshot()
				if snap.Counters[CntChangesReceived] == 0 && snap.Counters[CntChangesProcessed] == 0 {
					continue
				}
				Log(LogLevelMin, "%s", FormatSummary(snap))
				if cfg.MetricsFile != "" {
					writeMetricsFile(cfg.MetricsFile, snap)
				}
			}
		}()
	}

	if cfg.MetricsPort > 0 {
		mux := http.NewServeMux()
		mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
			snap := M.Snapshot()
			w.Header().Set("Content-Type", "application/json")
			enc := json.NewEncoder(w)
			enc.SetIndent("", "  ")
			enc.Encode(snap)
		})
		mux.HandleFunc("/metrics/prom", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain; version=0.0.4")
			fmt.Fprint(w, FormatPrometheus(M.Snapshot()))
		})
		mux.HandleFunc("/metrics/text", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/plain")
			fmt.Fprintln(w, FormatSummary(M.Snapshot()))
		})
		mux.HandleFunc("/metrics/reset", func(w http.ResponseWriter, r *http.Request) {
			M.Reset()
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"reset":true}`)
		})
		mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"ok":true,"mongoConnected":%v,"processActive":%v}`,
				mongoIsConnected(), ProcessStateIsActive())
		})
		addr := fmt.Sprintf(":%d", cfg.MetricsPort)
		Log(LogLevelMin, "Metrics - HTTP endpoint on %s (/metrics, /metrics/text, /metrics/prom, /metrics/reset)", addr)
		go func() {
			srv := &http.Server{
				Addr:              addr,
				Handler:           mux,
				ReadHeaderTimeout: 5 * time.Second,
			}
			if err := srv.ListenAndServe(); err != nil {
				Log(LogLevelMin, "Metrics - HTTP server error: %v", err)
			}
		}()
	}
}

func writeMetricsFile(path string, snap MetricsSnapshot) {
	b, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		Log(LogLevelDetailed, "Metrics - Error writing metrics file: %v", err)
		return
	}
	os.Rename(tmp, path)
}
