package serverapp

import (
	"context"
	"testing"
	"time"

	"github.com/dscsystems/go-dnp3/channel"
	"github.com/dscsystems/go-dnp3/master"
)

// startIINStation builds an outstation the way the driver does and connects a
// master to it.
func startIINStation(t *testing.T, ctx context.Context, conn *Connection) *master.Session {
	t.Helper()
	tags := []map[string]any{tag(1, "B0", true, 1, 0, 2, nil)}

	e := &Engine{byNum: map[int]*Connection{1: conn}}
	station := e.newOutstation(conn, toBsonSlice(tags))
	conn.setStation(station)

	mch, och := channel.Pipe()
	go func() { _ = station.Run(ctx, och) }()
	m := master.New(master.Config{
		LocalAddr: 1, RemoteAddr: 10, ResponseTimeout: 5 * time.Second,
	}, master.NopHandler{})
	go func() { _ = m.Run(ctx, mch) }()
	waitFor(t, "the master to connect", m.Connected)
	return m
}

// TestClockWriteAccepted checks that the master's clock write is accepted
// whatever timeSyncMode says, as the C++ server's DefaultOutstationApplication
// accepts it, and that the session answers normally afterwards.
//
// The outstation asks for the time (NEED_TIME) until a master sets it, so a
// refusal would be met with the same write on every connection.
func TestClockWriteAccepted(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	m := startIINStation(t, ctx, &Connection{
		ProtocolConnectionNumber: 1, Name: "DNP3SRV",
		LocalLinkAddress: 10, RemoteLinkAddress: 1, ServerQueueSize: 100,
		TimeSyncMode: 0,
	})

	rctx, rcancel := context.WithTimeout(ctx, 10*time.Second)
	defer rcancel()

	if err := m.WriteTime(rctx, time.Now()); err != nil {
		t.Fatalf("WriteTime: %v", err)
	}
	attrs, err := m.ReadAttributes(rctx)
	if err != nil {
		t.Fatalf("ReadAttributes after a clock write: %v", err)
	}
	if len(attrs) == 0 {
		t.Fatal("no device attributes after a clock write")
	}
	if err := m.IntegrityPoll(rctx); err != nil {
		t.Errorf("IntegrityPoll after a clock write: %v", err)
	}
}

// TestRefusedRequestDoesNotPoisonTheSession checks that a request the
// outstation refuses does not make it refuse the next one.
//
// IIN2.0 to IIN2.2 (no function code support, object unknown, parameter
// error) describe the request being answered, not the session. Reading an
// attribute set the outstation does not have is refused with OBJECT_UNKNOWN,
// correctly, and the device attribute read after it must still succeed.
//
// go-dnp3 v0.5.2 and earlier never cleared them, so after one refusal every
// later response carried it: dnp3-explorer reported "group 0 not implemented"
// after the server refused its clock write.
func TestRefusedRequestDoesNotPoisonTheSession(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	m := startIINStation(t, ctx, &Connection{
		ProtocolConnectionNumber: 1, Name: "DNP3SRV",
		LocalLinkAddress: 10, RemoteLinkAddress: 1, ServerQueueSize: 100,
	})

	rctx, rcancel := context.WithTimeout(ctx, 10*time.Second)
	defer rcancel()

	// Set 9 holds nothing: refused with OBJECT_UNKNOWN.
	if _, err := m.ReadAttributeSet(rctx, 9); err == nil {
		t.Fatal("reading an empty attribute set was not refused")
	}
	if _, err := m.ReadAttributes(rctx); err != nil {
		t.Fatalf("ReadAttributes after a refused request: %v", err)
	}
	if err := m.IntegrityPoll(rctx); err != nil {
		t.Errorf("IntegrityPoll after a refused request: %v", err)
	}
}
