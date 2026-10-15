//go:build testtools

// Read-only container probe. Never included in the runtime image; no networking.
package main

import (
	"fmt"
	"os"
	"webzoom/internal/lansetup"
)

func main() {
	raw, err := lansetup.SiteExecutable("/app/lan-client/WebZoom-LAN-Setup.exe", "https://approved.example", 34567)
	if err != nil || len(raw) < 2 || string(raw[:2]) != "MZ" {
		fmt.Fprintln(os.Stderr, "LAN client cannot be read and configured:", err)
		os.Exit(1)
	}
	fmt.Println("LAN_CLIENT_READABLE")
}
