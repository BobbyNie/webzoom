//go:build !windows

package main

import (
	"fmt"
	"os"
)

func main() { fmt.Fprintln(os.Stderr, "WebZoom LAN Setup is Windows-only."); os.Exit(1) }
