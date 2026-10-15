package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
	"webzoom/internal/lan"
	"webzoom/internal/lanhost"
)

// Real native executable + framed stdin/stdout, without Chrome registration or broadcast.
func TestNativeExecutableProtocolAndDiagnostic(t *testing.T) {
	dir := t.TempDir()
	name := "native-host"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	exe := filepath.Join(dir, name)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	build := exec.CommandContext(ctx, "go", "build", "-o", exe, ".")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build native: %s %v", out, err)
	}
	p := lanhost.Policy{Origin: "https://approved.example", ExtensionID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", InterfaceIP: "192.0.2.4", Port: 34567, MaxMbps: 8}
	raw, _ := json.Marshal(p)
	if err := os.WriteFile(filepath.Join(dir, "policy.json"), raw, 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, caller       string
		message            map[string]any
		wantType, wantCode string
	}{
		{"diagnostic", "chrome-extension://" + p.ExtensionID + "/", map[string]any{"type": "diagnose", "origin": p.Origin, "protocol": 1}, "diagnostic", "network_unsupported"},
		{"foreign site", "chrome-extension://" + p.ExtensionID + "/", map[string]any{"type": "start", "origin": "https://evil.example", "protocol": 1}, "error", "site_mismatch"},
		{"incompatible", "chrome-extension://" + p.ExtensionID + "/", map[string]any{"type": "start", "origin": p.Origin, "protocol": 2}, "error", "version_mismatch"},
		{"foreign extension", "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/", map[string]any{"type": "diagnose", "origin": p.Origin, "protocol": 1}, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var input, output, stderr bytes.Buffer
			lan.WriteMessage(&input, tc.message)
			cmd := exec.CommandContext(ctx, exe, tc.caller)
			cmd.Stdin = &input
			cmd.Stdout = &output
			cmd.Stderr = &stderr
			err := cmd.Run()
			if ctx.Err() != nil {
				t.Fatal("native timeout")
			}
			if tc.wantType == "" {
				if err == nil || output.Len() != 0 {
					t.Fatal("foreign caller accepted")
				}
				return
			}
			if tc.wantType == "diagnostic" && err != nil {
				t.Fatal(err)
			}
			var message map[string]any
			if err := lan.ReadMessage(&output, &message); err != nil {
				t.Fatal(err, stderr.String())
			}
			if message["type"] != tc.wantType || message["code"] != tc.wantCode {
				t.Fatal(message)
			}
			if output.Len() != 0 {
				t.Fatal("unframed stdout or duplicate error")
			}
			if tc.wantType == "diagnostic" && message["broadcastVerified"] != false {
				t.Fatal("claimed broadcast verification")
			}
		})
	}
}
