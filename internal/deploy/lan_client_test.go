//go:build deploymenttests

package deploy_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestBundledClientReadableWithDefaultAndArbitraryUID(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0755); err != nil {
		t.Fatal(err)
	}
	probe := filepath.Join(dir, "lan-client-check")
	cmd := exec.Command("go", "build", "-tags", "testtools", "-o", probe, "../../cmd/lancheck")
	for _, entry := range os.Environ() {
		key := strings.SplitN(strings.ToUpper(entry), "=", 2)[0]
		if key != "CGO_ENABLED" && key != "GOOS" && key != "GOARCH" {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, "CGO_ENABLED=0", "GOOS=linux", "GOARCH=amd64")
	if raw, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build probe: %v: %s", err, raw)
	}
	if err := os.Chmod(probe, 0555); err != nil {
		t.Fatal(err)
	}
	for _, uid := range []string{"65532:65532", "1001230000:0"} {
		t.Run(uid, func(t *testing.T) {
			output := docker(t, "run", "--rm", "--read-only", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", uid, "-v", probe+":/lan-client-check:ro", "--entrypoint", "/lan-client-check", applicationImage())
			if output != "LAN_CLIENT_READABLE" {
				t.Fatal(output)
			}
		})
	}
}
