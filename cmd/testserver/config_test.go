//go:build testtools

package main

import "testing"

func TestIsolatedFixturePort(t *testing.T) {
	t.Setenv("WEBZOOM_TEST_PORT", "18443")
	if fixtureOrigin() != "https://127.0.0.1:18443" {
		t.Fatal("fixture did not use isolated port")
	}
	t.Setenv("WEBZOOM_TEST_PORT", "")
	if fixtureOrigin() != "https://127.0.0.1:8443" {
		t.Fatal("default port changed")
	}
}
