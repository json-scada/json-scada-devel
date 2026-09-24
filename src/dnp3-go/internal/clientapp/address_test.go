package clientapp

import "testing"

// TestValidPointIndex pins the guard that keeps a command or range scan from
// being narrowed onto a different point: go-dnp3 carries 32-bit indexes, but
// the requests this driver sends carry 16.
func TestValidPointIndex(t *testing.T) {
	for _, c := range []struct {
		address int
		want    bool
	}{
		{0, true}, {5, true}, {65535, true},
		{-1, false}, {65536, false}, {65541, false},
	} {
		if got := validPointIndex(c.address); got != c.want {
			t.Errorf("validPointIndex(%d) = %v, want %v", c.address, got, c.want)
		}
	}
}
