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

func TestLoadTestLimitsDefaultDisabledAndValidate(t *testing.T) {
	for _, key := range []string{"LOAD_TEST_MAX_ROOMS", "LOAD_TEST_MAX_VIEWERS"} {
		for _, tc := range []struct {
			value string
			want  int
			bad   bool
		}{
			{"", 0, false}, {"0", 0, false}, {"5", 5, false}, {"200", 200, false},
			{"-1", 0, true}, {"abc", 0, true}, {"1.5", 0, true}, {"99999999999999999999999999", 0, true},
		} {
			t.Run(key+"/"+tc.value, func(t *testing.T) {
				t.Setenv(key, tc.value)
				got, err := loadTestLimit(key)
				if (err != nil) != tc.bad || got != tc.want {
					t.Fatalf("got %d, %v", got, err)
				}
			})
		}
	}
}
