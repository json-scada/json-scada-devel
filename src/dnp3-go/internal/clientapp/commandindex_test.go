package clientapp

import (
	"context"
	"sync"
	"testing"
	"time"

	"dnp3-go/internal/dnp3util"

	dnp3 "github.com/dscsystems/go-dnp3"
	"github.com/dscsystems/go-dnp3/channel"
	"github.com/dscsystems/go-dnp3/master"
	"github.com/dscsystems/go-dnp3/outstation"
)

// indexRecorder records which point each command operated.
type indexRecorder struct {
	mu      sync.Mutex
	crob    []uint16
	analogs []uint16
}

func (r *indexRecorder) SelectCROB(uint16, dnp3.ControlRelayOutputBlock) dnp3.CommandStatus {
	return dnp3.CommandSuccess
}

func (r *indexRecorder) OperateCROB(i uint16, _ dnp3.ControlRelayOutputBlock, _ outstation.OperateType) dnp3.CommandStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.crob = append(r.crob, i)
	return dnp3.CommandSuccess
}

func (r *indexRecorder) SelectAnalog(uint16, outstation.AnalogOutput) dnp3.CommandStatus {
	return dnp3.CommandSuccess
}

func (r *indexRecorder) OperateAnalog(i uint16, _ outstation.AnalogOutput, _ outstation.OperateType) dnp3.CommandStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.analogs = append(r.analogs, i)
	return dnp3.CommandSuccess
}

// TestCommandsReachTheirIndex operates points above 255, built the way
// executeCommand builds them, and checks the outstation operated those points.
//
// go-dnp3 before v0.5.4 wrote a command's index with a one-octet prefix
// whatever its value, so a command for point 300 operated point 44.
func TestCommandsReachTheirIndex(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	rec := &indexRecorder{}
	station := outstation.New(outstation.Config{
		LocalAddr: 10, RemoteAddr: 1,
		Database: outstation.DatabaseConfig{BinaryOutputStatus: 1000, AnalogOutputStatus: 1000},
	}, nil, rec)
	mch, och := channel.Pipe()
	go func() { _ = station.Run(ctx, och) }()

	session := master.New(master.Config{
		LocalAddr: 1, RemoteAddr: 10, ResponseTimeout: 3 * time.Second,
	}, master.NopHandler{})
	go func() { _ = session.Run(ctx, mch) }()

	deadline := time.Now().Add(5 * time.Second)
	for !session.Connected() {
		if time.Now().After(deadline) {
			t.Fatal("the master did not connect")
		}
		time.Sleep(20 * time.Millisecond)
	}

	rctx, rcancel := context.WithTimeout(ctx, 10*time.Second)
	defer rcancel()

	indexes := []uint16{5, 255, 256, 300, 999}
	for _, i := range indexes {
		if _, err := session.DirectOperate(rctx, master.CROB(i, dnp3util.CROBFor(3, 1))); err != nil {
			t.Fatalf("CROB %d direct operate: %v", i, err)
		}
		if _, err := session.SelectAndOperate(rctx, master.AnalogOutputFloat32(i, 1.5)); err != nil {
			t.Fatalf("analog %d select-before-operate: %v", i, err)
		}
	}

	rec.mu.Lock()
	defer rec.mu.Unlock()
	for n, want := range indexes {
		if n >= len(rec.crob) || rec.crob[n] != want {
			t.Errorf("CROB %d: outstation operated %v", want, rec.crob)
		}
		if n >= len(rec.analogs) || rec.analogs[n] != want {
			t.Errorf("analog %d: outstation operated %v", want, rec.analogs)
		}
	}
}
