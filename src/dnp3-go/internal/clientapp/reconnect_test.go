package clientapp

import (
	"context"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	dnp3 "github.com/dscsystems/go-dnp3"
	"github.com/dscsystems/go-dnp3/master"
	"github.com/dscsystems/go-dnp3/outstation"
)

// pipePair is a link that can be cut and re-made: every Connect on the master
// side makes a fresh in-memory connection and hands the other end to the
// outstation side's Connect.
type pipePair struct {
	mu       sync.Mutex
	current  net.Conn
	accept   chan net.Conn
	connects int
	downTill time.Time
}

func newPipePair() *pipePair { return &pipePair{accept: make(chan net.Conn)} }

// cut drops the current connection, as a cable pull or a router restart does,
// and keeps the link down for a while: long enough for the master to notice,
// as a real outage is.
func (p *pipePair) cut(outage time.Duration) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.downTill = time.Now().Add(outage)
	if p.current != nil {
		_ = p.current.Close()
	}
}

type pairEnd struct {
	p      *pipePair
	master bool
}

func (e pairEnd) Connect(ctx context.Context) (io.ReadWriteCloser, error) {
	if e.master {
		e.p.mu.Lock()
		wait := time.Until(e.p.downTill)
		e.p.mu.Unlock()
		if wait > 0 {
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		a, b := net.Pipe()
		select {
		case e.p.accept <- b:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		e.p.mu.Lock()
		e.p.current = a
		e.p.connects++
		e.p.mu.Unlock()
		return a, nil
	}
	select {
	case c := <-e.p.accept:
		return c, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (pairEnd) Close() error     { return nil }
func (e pairEnd) String() string { return "pipe-pair" }

// TestClassScansSurviveReconnection checks that the configured class polls run
// at their interval across reconnections, neither dropped nor multiplied.
//
// go-dnp3 before v0.5.4 cleared every task on connect, so the scans had to be
// registered again on each connection. From v0.5.4 periodic tasks survive, and
// registering again adds a second copy each time: after a few reconnections a
// one-second class poll runs several times a second.
func TestClassScansSurviveReconnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pair := newPipePair()
	station := outstation.New(outstation.Config{
		LocalAddr: 10, RemoteAddr: 1,
		Database: outstation.DatabaseConfig{Binary: 1, DefaultClass: dnp3.Class1},
	}, nil, nil)
	go func() { _ = station.Run(ctx, pairEnd{p: pair}) }()

	session := master.New(master.Config{
		LocalAddr: 1, RemoteAddr: 10, ResponseTimeout: 2 * time.Second,
	}, master.NopHandler{})
	go func() { _ = session.Run(ctx, pairEnd{p: pair, master: true}) }()

	conn := &Connection{Name: "RECONNECT", Class1ScanInterval: 1}
	go classScanLoop(ctx, conn, session)

	waitConnected := func() {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !session.Connected() {
			if time.Now().After(deadline) {
				t.Fatal("the master did not connect")
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	// requestsIn counts what the outstation receives over a steady window,
	// after the startup sequence of the last connection has settled.
	requestsIn := func(window time.Duration) uint64 {
		time.Sleep(1500 * time.Millisecond)
		before := station.Stats().RequestsReceived
		time.Sleep(window)
		return station.Stats().RequestsReceived - before
	}

	waitConnected()
	const window = 4 * time.Second
	baseline := requestsIn(window)
	if baseline == 0 {
		t.Fatal("no class polls at all before reconnecting")
	}

	for i := 0; i < 3; i++ {
		pair.cut(time.Second)
		deadline := time.Now().Add(5 * time.Second)
		for session.Connected() {
			if time.Now().After(deadline) {
				t.Fatal("the master did not notice the link going down")
			}
			time.Sleep(20 * time.Millisecond)
		}
		waitConnected()
	}

	after := requestsIn(window)
	pair.mu.Lock()
	connects := pair.connects
	pair.mu.Unlock()
	t.Logf("master connected %d times", connects)
	t.Logf("requests in %v: %d before reconnecting, %d after three reconnections", window, baseline, after)
	if after == 0 {
		t.Error("the class polls stopped after reconnecting")
	}
	// One poll a second either way; allow a poll of jitter.
	if after > baseline+1 {
		t.Errorf("%d requests after reconnecting against %d before: the class poll has been registered more than once",
			after, baseline)
	}
}
