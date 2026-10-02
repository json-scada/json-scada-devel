package serverapp

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestReadmeDocumentsEveryConfigKey keeps cmd/dnp3server/README.md in step with
// the code: every connection and destination key the driver reads must appear
// in it, in backticks. A key added without a line in the README fails here.
func TestReadmeDocumentsEveryConfigKey(t *testing.T) {
	readme, err := os.ReadFile("../../cmd/dnp3server/README.md")
	if err != nil {
		t.Fatal(err)
	}
	pattern := regexp.MustCompile(`Get\w+\((?:doc|d), "([A-Za-z0-9]+)"`)

	total := 0
	for _, file := range []string{"config.go", "model.go"} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range pattern.FindAllStringSubmatch(string(src), -1) {
			total++
			if !strings.Contains(string(readme), "`"+m[1]+"`") {
				t.Errorf("key %q is read by %s but not documented in cmd/dnp3server/README.md", m[1], file)
			}
		}
	}
	if total < 30 {
		t.Fatalf("found only %d keys; the pattern no longer matches the code", total)
	}
}
