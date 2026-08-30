package dnp3util

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dscsystems/go-dnp3/channel"
)

// fakeChannel returns whatever the test tells it to, counting the attempts.
type fakeChannel struct {
	attempts atomic.Int32
	err      error
}

func (f *fakeChannel) Connect(ctx context.Context) (io.ReadWriteCloser, error) {
	f.attempts.Add(1)
	if f.err != nil {
		return nil, f.err
	}
	return nopConn{}, nil
}

func (f *fakeChannel) Close() error   { return nil }
func (f *fakeChannel) String() string { return "fake" }

// TestCountChannelClosedPropagates pins the rule that a closed channel is not a
// failed connection attempt.
//
// The bus closes the underlying channel when the driver shuts down or a
// redundancy deactivation tears it down, and both sessions read
// channel.ErrClosed as a clean shutdown. Retrying it would spin against a
// channel that can never produce a connection, bump numOpenFail on every
// orderly shutdown, and hide the shutdown signal from the session.
func TestCountChannelClosedPropagates(t *testing.T) {
	inner := &fakeChannel{err: channel.ErrClosed}
	ch, counters := WrapCounting(inner, CountOptions{Name: "C", Retry: DefaultRetry})

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	start := time.Now()
	_, err := ch.Connect(ctx)
	elapsed := time.Since(start)

	if !errors.Is(err, channel.ErrClosed) {
		t.Errorf("Connect returned %v, want channel.ErrClosed", err)
	}
	if elapsed > time.Second {
		t.Errorf("Connect took %v; a closed channel must not be retried", elapsed)
	}
	if n := inner.attempts.Load(); n != 1 {
		t.Errorf("%d attempts, want exactly 1", n)
	}
	if c := counters.Snapshot(); c.OpenFails != 0 {
		t.Errorf("numOpenFail = %d, want 0: a shutdown is not a failed open", c.OpenFails)
	}
}

// TestCountChannelCancelledPropagates is the same rule for a cancelled context.
func TestCountChannelCancelledPropagates(t *testing.T) {
	inner := &fakeChannel{err: context.Canceled}
	ch, counters := WrapCounting(inner, CountOptions{Name: "C", Retry: DefaultRetry})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := ch.Connect(ctx); err == nil {
		t.Error("Connect on a cancelled context must fail")
	}
	if c := counters.Snapshot(); c.OpenFails != 0 {
		t.Errorf("numOpenFail = %d, want 0: cancellation is not a failed open", c.OpenFails)
	}
}

// TestCountChannelRetriesRealFailures checks the case the retry loop exists
// for: a genuine failure is counted and tried again, so numOpenFail reflects
// the attempts an operator is waiting on.
func TestCountChannelRetriesRealFailures(t *testing.T) {
	inner := &fakeChannel{err: errors.New("port is busy")}
	// A short backoff so several attempts fit in the test.
	ch, counters := WrapCounting(inner, CountOptions{
		Name:  "C",
		Retry: Retry{Min: 10 * time.Millisecond, Max: 20 * time.Millisecond, Factor: 1},
	})

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	if _, err := ch.Connect(ctx); err == nil {
		t.Error("Connect must fail while the inner channel keeps failing")
	}

	attempts := inner.attempts.Load()
	if attempts < 2 {
		t.Errorf("%d attempts, want the failure to be retried", attempts)
	}
	c := counters.Snapshot()
	if c.OpenFails < 2 {
		t.Errorf("numOpenFail = %d, want one per attempt (%d)", c.OpenFails, attempts)
	}
	if c.Opens != 0 {
		t.Errorf("numOpen = %d, want 0", c.Opens)
	}
}

// TestCountChannelCountsBytes checks the byte and open/close counters that feed
// the stats document.
func TestCountChannelCountsBytes(t *testing.T) {
	ch, counters := WrapCounting(&fakeChannel{}, CountOptions{Name: "C"})

	conn, err := ch.Connect(context.Background())
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Closing twice must not count two disconnections.
	_ = conn.Close()

	c := counters.Snapshot()
	if c.Opens != 1 {
		t.Errorf("numOpen = %d, want 1", c.Opens)
	}
	if c.BytesTx != 5 {
		t.Errorf("numBytesTx = %d, want 5", c.BytesTx)
	}
	if c.Closes != 1 {
		t.Errorf("numClose = %d, want 1 even though Close was called twice", c.Closes)
	}
}
