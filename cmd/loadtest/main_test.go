package main

import (
	"io"
	"testing"
)

func TestCLIRejectsMissingCredentials(t *testing.T) {
	if err := run(nil, io.Discard); err == nil {
		t.Fatal("missing session file accepted")
	}
}
func TestCLIRejectsPlainHTTP(t *testing.T) {
	if err := run([]string{"-url", "http://example.test", "-sessions", "missing.json"}, io.Discard); err == nil {
		t.Fatal("HTTP accepted")
	}
}
