package serverapp

import (
	"context"
	"testing"
	"time"

	dnp3 "github.com/dscsystems/go-dnp3"
	"github.com/dscsystems/go-dnp3/channel"
	"github.com/dscsystems/go-dnp3/master"
)

// TestCommandTagChangeDoesNotTouchSuppliedPoints checks that a change to a
// command tag is not distributed as data.
//
// A command tag carries a destination in group 12 or 41, and familyOf sends an
// unrecognised group to the analog family, so applying one wrote its value over
// the supervised analog at the same index. The initial load never did this,
// because tagsFor takes only origin "supervised"; the change stream has to
// agree with it.
func TestCommandTagChangeDoesNotTouchSuppliedPoints(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	conn := &Connection{
		ProtocolConnectionNumber: 1, Name: "SRV",
		LocalLinkAddress: 10, RemoteLinkAddress: 1, ServerQueueSize: 100,
	}
	tags := []map[string]any{
		tag(1, "AI0", 1.5, 30, 0, 5, nil),
		tag(2, "AI1", 2.5, 30, 1, 5, nil),
	}

	e := &Engine{byNum: map[int]*Connection{1: conn}}
	station := e.newOutstation(conn, toBsonSlice(tags))
	conn.setStation(station)

	mch, och := channel.Pipe()
	go func() { _ = station.Run(ctx, och) }()
	rec := newRecorder()
	m := master.New(master.Config{
		LocalAddr: 1, RemoteAddr: 10, ResponseTimeout: 3 * time.Second,
	}, rec)
	go func() { _ = m.Run(ctx, mch) }()
	waitFor(t, "the master to connect", m.Connected)

	// Command tags: a CROB at group 12 and an analog output block at group 41,
	// both at index 0, where the supervised analog is.
	e.distribute(toBson(tag(10, "CMD_CROB", 7.0, 12, 0, 1, map[string]any{"origin": "command"})))
	e.distribute(toBson(tag(11, "CMD_AO", 8.0, 41, 0, 3, map[string]any{"origin": "command"})))
	// Updates are applied in order, so once this sentinel shows, the two above
	// have been applied too if they were going to be.
	e.distribute(toBson(tag(2, "AI1", 9.0, 30, 1, 5, nil)))

	waitFor(t, "the sentinel update to be applied", func() bool {
		if err := m.IntegrityPoll(ctx); err != nil {
			t.Fatalf("IntegrityPoll: %v", err)
		}
		rec.lock()
		defer rec.unlock()
		return rec.analogs[1].Value == 9.0
	})

	rec.lock()
	defer rec.unlock()
	if got := rec.analogs[0]; got.Value != 1.5 || !got.Flags.Has(dnp3.Online) {
		t.Errorf("analog 0 = %v (flags %v) after command tags changed, want 1.5 untouched", got.Value, got.Flags)
	}
}
