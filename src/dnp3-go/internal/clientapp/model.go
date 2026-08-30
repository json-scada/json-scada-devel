/*
 * DNP3 Client Protocol driver for {json:scada}, in Go.
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

// The connection model and the value queue. Ports of DNP3Connection,
// Dnp3Value and enqueueValue() of the C++ client.

package clientapp

import (
	"context"
	"sync"
	"sync/atomic"

	"dnp3-go/internal/dnp3util"

	"github.com/dscsystems/go-dnp3/channel"
	"github.com/dscsystems/go-dnp3/master"
)

// Driver identity.
const (
	ProtocolDriverName = "DNP3"
	DriverVersion      = "0.2.0"
	DriverMessage      = "{json:scada} DNP3 Client Driver (Go)"
)

// DataBufferLimit is how many acquired values may wait for the MongoDB writer
// before the oldest are dropped.
const DataBufferLimit = 10000

// AutoKeyMultiplier spaces the _id ranges of auto-created tags per connection.
const AutoKeyMultiplier = 1000000.0

// RangeScan is one entry of the rangeScans array.
type RangeScan struct {
	Group        int
	Variation    int
	StartAddress int
	StopAddress  int
	Period       int
}

// Connection is one protocolConnections document plus the runtime state of its
// DNP3 session.
type Connection struct {
	ProtocolDriverInstanceNumber int
	ProtocolConnectionNumber     int
	Name                         string
	Enabled                      bool
	CommandsEnabled              bool
	ConnectionMode               string
	IPAddressLocalBind           string
	IPAddresses                  []string
	PortName                     string
	BaudRate                     int
	Parity                       string
	StopBits                     string
	Handshake                    string
	AsyncOpenDelay               int
	AllowTLSv10                  bool
	AllowTLSv11                  bool
	AllowTLSv12                  bool
	AllowTLSv13                  bool
	CipherList                   string
	LocalCertFilePath            string
	PeerCertFilePath             string
	PrivateKeyFilePath           string
	LocalLinkAddress             int
	RemoteLinkAddress            int
	GIInterval                   int
	Class0ScanInterval           int
	Class1ScanInterval           int
	Class2ScanInterval           int
	Class3ScanInterval           int
	RangeScans                   []RangeScan
	TimeSyncMode                 int
	EnableUnsolicited            bool
	AutoCreateTags               bool

	// Runtime state.

	// Chan is the sub-channel of the shared bus this session runs on.
	Chan channel.Channel
	// Group is the bus the connection is on, shared with its multi-drop peers.
	Group *dnp3util.Group

	mu      sync.Mutex
	session *master.Session
	cancel  context.CancelFunc

	connected atomic.Bool
	// wasConnected tracks the previous poll of Connected(), so a fall to
	// disconnected can invalidate the connection's points exactly once.
	wasConnected bool

	// Touched only by the MongoDB writer goroutine, after the initial preload.
	lastNewKeyCreated float64
	insertedAddresses map[[2]int]bool
}

// Session returns the running session, or nil while this node is standby.
func (c *Connection) Session() *master.Session {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.session
}

// setSession stores the session and its cancel function.
func (c *Connection) setSession(s *master.Session, cancel context.CancelFunc) {
	c.mu.Lock()
	c.session, c.cancel = s, cancel
	c.mu.Unlock()
}

// stopSession cancels the session's context and forgets it.
func (c *Connection) stopSession() {
	c.mu.Lock()
	cancel := c.cancel
	c.session, c.cancel = nil, nil
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	c.connected.Store(false)
}

// Connected reports whether the DNP3 session has a live link.
func (c *Connection) Connected() bool { return c.connected.Load() }

// ChannelSpec describes this connection's physical channel.
func (c *Connection) ChannelSpec() dnp3util.ChannelSpec {
	return dnp3util.ChannelSpec{
		Name:               c.Name,
		Mode:               c.ConnectionMode,
		IPAddresses:        c.IPAddresses,
		IPAddressLocalBind: c.IPAddressLocalBind,
		PortName:           c.PortName,
		BaudRate:           c.BaudRate,
		Parity:             c.Parity,
		StopBits:           c.StopBits,
		Handshake:          c.Handshake,
		AsyncOpenDelayMs:   c.AsyncOpenDelay,
		LocalCertFilePath:  c.LocalCertFilePath,
		PeerCertFilePath:   c.PeerCertFilePath,
		PrivateKeyFilePath: c.PrivateKeyFilePath,
		CipherList:         c.CipherList,
		AllowTLSv10:        c.AllowTLSv10,
		AllowTLSv11:        c.AllowTLSv11,
		AllowTLSv12:        c.AllowTLSv12,
		AllowTLSv13:        c.AllowTLSv13,
	}
}

// shortestScanPeriod is the fastest configured poll, used only for the
// multi-drop pacing warning.
func (c *Connection) shortestScanPeriod() int {
	best := 0
	consider := func(p int) {
		if p > 0 && (best == 0 || p < best) {
			best = p
		}
	}
	consider(c.GIInterval)
	consider(c.Class0ScanInterval)
	consider(c.Class1ScanInterval)
	consider(c.Class2ScanInterval)
	consider(c.Class3ScanInterval)
	for _, rs := range c.RangeScans {
		consider(rs.Period)
	}
	return best
}

// Dnp3Value is one measurement on its way to realtimeData.
type Dnp3Value struct {
	Address     int
	BaseGroup   int
	Group       int
	Variation   int
	Value       float64
	ValueString string
	// COT is always 20 in the C++ driver, and stays so (quirk Q4).
	COT                int
	ServerTimestamp    int64
	HasSourceTimestamp bool
	SourceTimestamp    int64
	TimeTagOk          bool
	Quality            dnp3util.Quality
	ConnNumber         int
}

// ValueQueue is the bounded queue between the DNP3 sessions and the MongoDB
// writer. It drops the oldest value when full, as enqueueValue() does.
type ValueQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	values []Dnp3Value
	closed bool
}

// NewValueQueue returns an empty queue.
func NewValueQueue() *ValueQueue {
	q := &ValueQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// Push enqueues a value, dropping the oldest when the queue is full.
func (q *ValueQueue) Push(v Dnp3Value) {
	q.mu.Lock()
	if len(q.values) >= DataBufferLimit {
		q.values = q.values[1:]
	}
	q.values = append(q.values, v)
	q.mu.Unlock()
	q.cond.Signal()
}

// Drain takes everything queued, blocking until there is something or the
// queue is closed. It returns nil once closed and empty.
func (q *ValueQueue) Drain() []Dnp3Value {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.values) == 0 && !q.closed {
		q.cond.Wait()
	}
	batch := q.values
	q.values = nil
	return batch
}

// Close wakes a blocked Drain so the writer can exit.
func (q *ValueQueue) Close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.cond.Broadcast()
}
