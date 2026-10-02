package clientapp

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestReadmeDocumentsEveryConfigKey keeps cmd/dnp3client/README.md in step with
// the code: every key connectionFromDoc reads must appear in it, in backticks.
// A key added to config.go without a line in the README fails here.
func TestReadmeDocumentsEveryConfigKey(t *testing.T) {
	src, err := os.ReadFile("config.go")
	if err != nil {
		t.Fatal(err)
	}
	readme, err := os.ReadFile("../../cmd/dnp3client/README.md")
	if err != nil {
		t.Fatal(err)
	}

	keys := regexp.MustCompile(`Get\w+\((?:doc|rs), "([A-Za-z0-9]+)"`).FindAllStringSubmatch(string(src), -1)
	if len(keys) < 30 {
		t.Fatalf("found only %d configuration keys in config.go; the pattern no longer matches the code", len(keys))
	}
	for _, m := range keys {
		if !strings.Contains(string(readme), "`"+m[1]+"`") {
			t.Errorf("config key %q is read by config.go but not documented in cmd/dnp3client/README.md", m[1])
		}
	}
}
