// landist cross-builds the same unsigned Windows client for CI and the server image.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"webzoom/internal/lansetup"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	out := flag.String("out", "artifacts/lan-release", "output directory")
	flag.Parse()
	if err := os.MkdirAll(*out, 0700); err != nil {
		return err
	}
	tmp, err := os.MkdirTemp(*out, "build-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	host, stub := filepath.Join(tmp, "host.exe"), filepath.Join(tmp, "setup.exe")
	for _, item := range []struct{ target, pkg, flags string }{{host, "./cmd/lanhost", "-s -w -buildid="}, {stub, "./cmd/lansetup", "-s -w -buildid= -H windowsgui"}} {
		cmd := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-ldflags", item.flags, "-o", item.target, item.pkg)
		// Remove inherited GOOS/GOARCH rather than relying on duplicate environment keys on Windows.
		for _, env := range os.Environ() {
			if strings.HasPrefix(strings.ToUpper(env), "GOOS=") || strings.HasPrefix(strings.ToUpper(env), "GOARCH=") || strings.HasPrefix(strings.ToUpper(env), "CGO_ENABLED=") {
				continue
			}
			cmd.Env = append(cmd.Env, env)
		}
		cmd.Env = append(cmd.Env, "GOOS=windows", "GOARCH=amd64", "CGO_ENABLED=0")
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return err
		}
	}
	b := &lansetup.Bundle{Config: lansetup.Config{ConfigureOnInstall: true, ExtensionID: "hmeoffkckocfjcblblfhpmjcighdehfa"}, Files: map[string][]byte{}}
	for _, name := range []string{"manifest.json", "background.js", "content.js", "popup.html", "popup.js", "messages.js", "diagnostic-client.js"} {
		b.Files["extension/"+name], err = os.ReadFile(filepath.Join("clients/chrome", name))
		if err != nil {
			return err
		}
		b.Files["extension/"+name] = bytes.ReplaceAll(b.Files["extension/"+name], []byte("\r\n"), []byte("\n"))
	}
	b.Files["extension/policy.js"] = []byte("export const origin = '';")
	b.Files["native/webzoom-lan-host.exe"], err = os.ReadFile(host)
	if err != nil {
		return err
	}
	b.Files["native/bundle.json"], err = json.Marshal(b.Config)
	if err != nil {
		return err
	}
	guide, err := os.ReadFile("docs/LAN_CLIENT_QUICKSTART.md")
	if err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(*out, "使用说明.md"), guide, 0600); err != nil {
		return err
	}
	target := filepath.Join(*out, "WebZoom-LAN-Setup.exe")
	if err = b.WriteExecutable(stub, target); err != nil {
		return err
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(*out, "SHA256SUMS.txt"), []byte(fmt.Sprintf("%x  WebZoom-LAN-Setup.exe\n", sha256.Sum256(raw))), 0600)
}
