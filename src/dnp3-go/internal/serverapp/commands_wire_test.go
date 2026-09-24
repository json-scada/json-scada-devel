package serverapp

import (
	"testing"

	dnp3 "github.com/dscsystems/go-dnp3"
)

// TestCROBValueWireCodes checks the value a received control code turns into,
// from the raw octet a master puts on the wire rather than from the library's
// constants: go-dnp3 before v0.5.3 had ControlClose and ControlTrip
// transposed, and a test written against the constants agreed with them.
//
// The octets are what opendnp3, and so the C++ client driver, sends: the
// operation type in the low nibble and the trip/close code in bits 7-6, 1 for
// close and 2 for trip.
func TestCROBValueWireCodes(t *testing.T) {
	for _, c := range []struct {
		code byte
		want float64
		what string
	}{
		{0x41, 1, "PULSE_ON + CLOSE"},
		{0x43, 1, "LATCH_ON + CLOSE"},
		{0x81, 0, "PULSE_ON + TRIP"},
		{0x83, 0, "LATCH_ON + TRIP"},
		{0x42, 1, "PULSE_OFF + CLOSE: the coil decides"},
		{0x82, 0, "PULSE_OFF + TRIP"},
		{0x01, 1, "PULSE_ON"},
		{0x02, 0, "PULSE_OFF"},
		{0x03, 1, "LATCH_ON"},
		{0x04, 0, "LATCH_OFF"},
	} {
		if got := crobValue(dnp3.ControlCode(c.code)); got != c.want {
			t.Errorf("0x%02X (%s) = %v, want %v", c.code, c.what, got, c.want)
		}
	}
}
