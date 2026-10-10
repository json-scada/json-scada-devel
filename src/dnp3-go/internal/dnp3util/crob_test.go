package dnp3util

import (
	"testing"

	dnp3 "github.com/dscsystems/go-dnp3"
)

// TestCROBFor checks every documented protocolSourceCommandDuration against the
// switch of the C++ client's executeCommand().
func TestCROBFor(t *testing.T) {
	const on, off = 1.0, 0.0

	cases := []struct {
		duration int
		value    float64
		code     dnp3.ControlCode
		pulsed   bool
	}{
		// PULSE 1=ON 0=OFF
		{1, on, dnp3.ControlPulseOn, true},
		{1, off, dnp3.ControlPulseOff, true},
		// PULSE 0=ON 1=OFF
		{2, on, dnp3.ControlPulseOff, true},
		{2, off, dnp3.ControlPulseOn, true},
		// LATCH 1=ON 0=OFF
		{3, on, dnp3.ControlLatchOn, false},
		{3, off, dnp3.ControlLatchOff, false},
		// LATCH 0=ON 1=OFF
		{4, on, dnp3.ControlLatchOff, false},
		{4, off, dnp3.ControlLatchOn, false},
		// PULSE 1=ON,CLOSE 0=OFF,TRIP
		{11, on, dnp3.ControlPulseOn | dnp3.ControlClose, true},
		{11, off, dnp3.ControlPulseOff | dnp3.ControlTrip, true},
		// LATCH 1=ON,CLOSE 0=OFF,TRIP
		{13, on, dnp3.ControlLatchOn | dnp3.ControlClose, false},
		{13, off, dnp3.ControlLatchOff | dnp3.ControlTrip, false},
		// PULSE 1=ON,TRIP 0=OFF,CLOSE
		{21, on, dnp3.ControlPulseOn | dnp3.ControlTrip, true},
		{21, off, dnp3.ControlPulseOff | dnp3.ControlClose, true},
		// LATCH 1=ON,TRIP 0=OFF,CLOSE
		{23, on, dnp3.ControlLatchOn | dnp3.ControlTrip, false},
		{23, off, dnp3.ControlLatchOff | dnp3.ControlClose, false},
	}

	for _, c := range cases {
		got := CROBFor(c.duration, c.value)
		if got.Code != c.code {
			t.Errorf("duration %d value %v: code = %s, want %s",
				c.duration, c.value, got.Code, c.code)
		}
		if got.Count != 1 {
			t.Errorf("duration %d value %v: count = %d, want 1", c.duration, c.value, got.Count)
		}
		wantOn, wantOff := uint32(0), uint32(0)
		if c.pulsed {
			wantOn, wantOff = CROBPulseOnTime, CROBPulseOffTime
		}
		if got.OnTime != wantOn || got.OffTime != wantOff {
			t.Errorf("duration %d value %v: on/off = %d/%d, want %d/%d",
				c.duration, c.value, got.OnTime, got.OffTime, wantOn, wantOff)
		}
	}
}

// TestCROBForUnimplemented pins quirk Q3: durations 10, 12, 20 and 22 are in
// the driver README's table but were never implemented by the C++ switch, and
// fall through to a block that operates nothing. Reproduced deliberately — a
// guess here would operate the wrong coil of a breaker.
func TestCROBForUnimplemented(t *testing.T) {
	for _, duration := range []int{0, 10, 12, 20, 22, 5, 99} {
		for _, value := range []float64{0, 1} {
			got := CROBFor(duration, value)
			if got.Code != dnp3.ControlNUL {
				t.Errorf("duration %d value %v: code = %s, want NUL", duration, value, got.Code)
			}
			if got.OnTime != 0 || got.OffTime != 0 {
				t.Errorf("duration %d value %v: expected no pulse times", duration, value)
			}
		}
	}
}

// TestCROBWireCodes pins the octet each duration puts on the wire, which is
// what a device acts on. The table above compares against the library's
// constants, so it agreed with go-dnp3 releases before v0.5.3 that had
// ControlClose and ControlTrip transposed — and sent a trip where a close was
// meant. These octets are the C++ client's (opendnp3: operation type in the
// low nibble, trip/close code in bits 7-6, 1 = close = 0x40, 2 = trip = 0x80).
func TestCROBWireCodes(t *testing.T) {
	for _, c := range []struct {
		duration int
		on, off  byte
	}{
		{1, 0x01, 0x02},  // PULSE 1=ON 0=OFF
		{2, 0x02, 0x01},  // PULSE 0=ON 1=OFF
		{3, 0x03, 0x04},  // LATCH 1=ON 0=OFF
		{4, 0x04, 0x03},  // LATCH 0=ON 1=OFF
		{11, 0x41, 0x82}, // PULSE CLOSE 1=ON / PULSE TRIP 0=OFF
		{13, 0x43, 0x84}, // LATCH CLOSE / LATCH TRIP
		{21, 0x81, 0x42}, // PULSE TRIP 1=ON / PULSE CLOSE 0=OFF
		{23, 0x83, 0x44}, // LATCH TRIP / LATCH CLOSE
		{0, 0x00, 0x00},  // NUL
	} {
		if got := byte(CROBFor(c.duration, 1).Code); got != c.on {
			t.Errorf("duration %d, value 1: code 0x%02X, want 0x%02X", c.duration, got, c.on)
		}
		if got := byte(CROBFor(c.duration, 0).Code); got != c.off {
			t.Errorf("duration %d, value 0: code 0x%02X, want 0x%02X", c.duration, got, c.off)
		}
	}
}
