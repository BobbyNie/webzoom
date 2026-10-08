package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSecretFilesAndConflicts(t *testing.T) {
	t.Setenv("TEST_SECRET", "")
	t.Setenv("TEST_SECRET_FILE", "")
	p := filepath.Join(t.TempDir(), "secret")
	if e := os.WriteFile(p, []byte("secret-value\n"), 0600); e != nil {
		t.Fatal(e)
	}
	t.Setenv("TEST_SECRET_FILE", p)
	got, e := secret("TEST_SECRET")
	if e != nil || got != "secret-value" {
		t.Fatal(got, e)
	}
	t.Setenv("TEST_SECRET", "other")
	if _, e = secret("TEST_SECRET"); e == nil {
		t.Fatal("ambiguous secret sources")
	}
	t.Setenv("TEST_SECRET_FILE", "")
	got, e = secret("TEST_SECRET")
	if e != nil || got != "other" {
		t.Fatal(got, e)
	}
	t.Setenv("TEST_SECRET", "")
	t.Setenv("TEST_SECRET_FILE", p+"missing")
	if _, e = secret("TEST_SECRET"); e == nil {
		t.Fatal("missing secret file accepted")
	}
}
