// webzoom-lan-host is launched only by Chrome Native Messaging. No local TCP listener.
package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"webzoom/internal/lanhost"
)

func main() {
	exe, e := os.Executable()
	if e != nil {
		os.Exit(1)
	}
	b, e := os.ReadFile(filepath.Join(filepath.Dir(exe), "policy.json"))
	var p lanhost.Policy
	if e != nil || len(b) > 8192 || json.Unmarshal(b, &p) != nil || len(os.Args) < 2 || p.Validate(os.Args[1]) != nil {
		os.Exit(1)
	}
	if e = lanhost.Run(context.Background(), p, os.Stdin, os.Stdout); e != nil {
		os.Exit(1)
	}
}
