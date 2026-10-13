//go:build !windows || !amd64

package main

import "fmt"

func main() { fmt.Println("WebZoom Overlay requires Windows 10 2004+ / Windows 11, x64.") }
