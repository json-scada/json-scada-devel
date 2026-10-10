package serverapp

import (
	"context"
	"testing"
	"time"

	dnp3 "github.com/dscsystems/go-dnp3"
	"github.com/dscsystems/go-dnp3/channel"
	"github.com/dscsystems/go-dnp3/master"
)

// seenEvent is one event a master decoded: which object carried it and the
// time it came with.
type seenEvent struct {
	group     uint8
	variation uint8
	value     float64
	time      dnp3.Timestamp
}

// eventRecorder keeps the events only, per point, so the static values of the
// integrity poll cannot be mistaken for them.
type eventRecorder struct {
	master.NopHandler
	mu       chan struct{}
	binaries map[uint32]seenEvent
	doubles  map[uint32]seenEvent
	analogs  map[uint32]seenEvent
}

func newEventRecorder() *eventRecorder {
	r := &eventRecorder{
		mu:       make(chan struct{}, 1),
		binaries: map[uint32]seenEvent{},
		doubles:  map[uint32]seenEvent{},
		analogs:  map[uint32]seenEvent{},
	}
	r.mu <- struct{}{}
	return r
}

func (r *eventRecorder) lock()   { <-r.mu }
func (r *eventRecorder) unlock() { r.mu <- struct{}{} }

func (r *eventRecorder) HandleBinary(h master.HeaderInfo, vs []dnp3.Indexed[dnp3.Binary]) {
	if !h.IsEvent() {
		return
	}
	r.lock()
	defer r.unlock()
	for _, v := range vs {
		val := 0.0
		if v.Value.Value {
			val = 1
		}
		r.binaries[v.Index] = seenEvent{h.GV.Group, h.GV.Variation, val, v.Value.Time}
	}
}

func (r *eventRecorder) HandleDoubleBit(h master.HeaderInfo, vs []dnp3.Indexed[dnp3.DoubleBitBinary]) {
	if !h.IsEvent() {
		return
	}
	r.lock()
	defer r.unlock()
	for _, v := range vs {
		r.doubles[v.Index] = seenEvent{h.GV.Group, h.GV.Variation, float64(v.Value.Value), v.Value.Time}
	}
}

func (r *eventRecorder) HandleAnalog(h master.HeaderInfo, vs []dnp3.Indexed[dnp3.Analog]) {
	if !h.IsEvent() {
		return
	}
	r.lock()
	defer r.unlock()
	for _, v := range vs {
		r.analogs[v.Index] = seenEvent{h.GV.Group, h.GV.Variation, v.Value.Value, v.Value.Time}
	}
}

// TestChangesAreTimedEvents checks that a changed digital or analog value
// reaches the master as an event with a time, whatever ASDU the destination
// asked for, and that the time is the field time of the tag when it has one,
// the local update time when it does not, and the moment of the update when it
// has neither.
func TestChangesAreTimedEvents(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	conn := &Connection{
		ProtocolConnectionNumber: 1,
		Name:                     "SRV",
		LocalLinkAddress:         10,
		RemoteLinkAddress:        1,
		ServerQueueSize:          100,
	}

	// Millisecond times, which is what DNP3 carries.
	fieldTime := time.UnixMilli(1_700_000_000_123)
	localTime := time.UnixMilli(1_700_000_100_456)
	field := map[string]any{"timeTagAtSource": fieldTime, "timeTagAtSourceOk": true, "timeTag": localTime}
	local := map[string]any{"timeTagAtSource": nil, "timeTag": localTime}

	type point struct {
		id                float64
		name              string
		group, addr, asdu int
		before, after     any
		extra             map[string]any
		wantVariation     uint8
		wantTime          time.Time // zero: the moment of the update
	}
	points := []point{
		{1, "BIN_FIELD", 1, 0, 2, false, true, field, 2, fieldTime},
		{2, "BIN_LOCAL", 1, 1, 2, true, false, local, 2, localTime},
		{3, "DBL_FIELD", 3, 0, 2, false, true, field, 2, fieldTime},
		{4, "DBL_LOCAL", 3, 1, 2, true, false, local, 2, localTime},
		// The analog ASDUs whose C++ event variation has no time.
		{5, "ANA_ASDU1", 30, 0, 1, 10.0, 20.0, field, 3, fieldTime},
		{6, "ANA_ASDU2", 30, 1, 2, 10.0, 21.0, local, 4, localTime},
		{7, "ANA_ASDU5", 30, 2, 5, 1.5, 2.5, field, 7, fieldTime},
		{8, "ANA_ASDU6", 30, 3, 6, 1.25, 3.75, local, 8, localTime},
		// No time on the tag at all.
		{9, "ANA_NOW", 30, 4, 5, 1.0, 2.0, nil, 7, time.Time{}},
	}

	var tags []map[string]any
	for _, p := range points {
		tags = append(tags, tag(p.id, p.name, p.before, p.group, p.addr, p.asdu, nil))
	}

	e := &Engine{byNum: map[int]*Connection{1: conn}}
	station := e.newOutstation(conn, toBsonSlice(tags))
	conn.setStation(station)

	mch, och := channel.Pipe()
	go func() { _ = station.Run(ctx, och) }()

	rec := newEventRecorder()
	m := master.New(master.Config{
		LocalAddr: 1, RemoteAddr: 10,
		ResponseTimeout: 3 * time.Second,
	}, rec)
	go func() { _ = m.Run(ctx, mch) }()

	waitFor(t, "the master to connect", m.Connected)
	if err := m.IntegrityPoll(ctx); err != nil {
		t.Fatalf("IntegrityPoll: %v", err)
	}
	// Whatever the initial load queued is gone now; only the changes below
	// can produce events.
	rec.lock()
	clear(rec.binaries)
	clear(rec.doubles)
	clear(rec.analogs)
	rec.unlock()

	before := time.Now().Add(-time.Second)
	for _, p := range points {
		e.distribute(toBson(tag(p.id, p.name, p.after, p.group, p.addr, p.asdu, p.extra)))
	}
	after := time.Now().Add(time.Second)

	// Session.Update hands each change to the session loop rather than applying
	// it in place, so keep polling until every change has been reported.
	waitFor(t, "an event for every change", func() bool {
		if err := m.ScanClasses(ctx, dnp3.Class123); err != nil {
			t.Fatalf("ScanClasses: %v", err)
		}
		rec.lock()
		defer rec.unlock()
		return len(rec.binaries)+len(rec.doubles)+len(rec.analogs) >= len(points)
	})

	rec.lock()
	defer rec.unlock()
	for _, p := range points {
		var (
			ev        seenEvent
			ok        bool
			wantGroup uint8
		)
		switch p.group {
		case 1:
			ev, wantGroup = rec.binaries[uint32(p.addr)], 2
			_, ok = rec.binaries[uint32(p.addr)]
		case 3:
			ev, wantGroup = rec.doubles[uint32(p.addr)], 4
			_, ok = rec.doubles[uint32(p.addr)]
		default:
			ev, wantGroup = rec.analogs[uint32(p.addr)], 32
			_, ok = rec.analogs[uint32(p.addr)]
		}
		if !ok {
			t.Errorf("%s: the change produced no event", p.name)
			continue
		}
		if ev.group != wantGroup || ev.variation != p.wantVariation {
			t.Errorf("%s: event came as g%dv%d, want g%dv%d",
				p.name, ev.group, ev.variation, wantGroup, p.wantVariation)
		}
		if ev.time.Quality == dnp3.TimestampInvalid || ev.time.Time.IsZero() {
			t.Errorf("%s: event carries no time", p.name)
			continue
		}
		got := ev.time.Time
		if p.wantTime.IsZero() {
			if got.Before(before) || got.After(after) {
				t.Errorf("%s: event time %v, want the moment of the update", p.name, got)
			}
		} else if !got.Equal(p.wantTime) {
			t.Errorf("%s: event time %v, want %v", p.name, got, p.wantTime)
		}
	}
}

// TestMixedAnalogStaticsKeepTheirVariation checks that an integrity poll
// reports each analog in its own static variation. go-dnp3 before v0.5.0
// encoded a whole range in the variation of its first point, so a float analog
// after an integer one was read back truncated.
func TestMixedAnalogStaticsKeepTheirVariation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	conn := &Connection{
		ProtocolConnectionNumber: 1,
		Name:                     "SRV",
		LocalLinkAddress:         10,
		RemoteLinkAddress:        1,
		ServerQueueSize:          100,
	}
	tags := []map[string]any{
		tag(1, "ANA_INT32", 10.0, 30, 0, 1, nil),  // g30v1, integer
		tag(2, "ANA_FLOAT", 1.5, 30, 1, 5, nil),   // g30v5
		tag(3, "ANA_DOUBLE", 3.75, 30, 2, 6, nil), // g30v6
		tag(4, "ANA_INT16", 7.0, 30, 3, 2, nil),   // g30v2, integer
		tag(5, "ANA_FLOAT2", -2.25, 30, 4, 5, nil),
	}

	e := &Engine{byNum: map[int]*Connection{1: conn}}
	station := e.newOutstation(conn, toBsonSlice(tags))
	conn.setStation(station)

	mch, och := channel.Pipe()
	go func() { _ = station.Run(ctx, och) }()

	rec := newRecorder()
	m := master.New(master.Config{
		LocalAddr: 1, RemoteAddr: 10,
		ResponseTimeout: 3 * time.Second,
	}, rec)
	go func() { _ = m.Run(ctx, mch) }()

	waitFor(t, "the master to connect", m.Connected)
	if err := m.IntegrityPoll(ctx); err != nil {
		t.Fatalf("IntegrityPoll: %v", err)
	}

	rec.lock()
	defer rec.unlock()
	for i, want := range []float64{10, 1.5, 3.75, 7, -2.25} {
		if got := rec.analogs[uint32(i)].Value; got != want {
			t.Errorf("analog %d = %v, want %v", i, got, want)
		}
	}
}
