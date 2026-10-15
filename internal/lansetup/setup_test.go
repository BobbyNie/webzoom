package lansetup

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

type fakeRegistry struct {
	value           string
	writes, deletes int
	failWrite       bool
}

func (r *fakeRegistry) Read() (string, error) { return r.value, nil }
func (r *fakeRegistry) Write(v string) error {
	r.writes++
	if r.failWrite {
		return errors.New("injected write failure")
	}
	r.value = v
	return nil
}
func (r *fakeRegistry) Delete() error { r.deletes++; r.value = ""; return nil }
func fixture(t *testing.T) (*Installer, *fakeRegistry) {
	t.Helper()
	c := Config{Origin: "https://approved.example", ExtensionID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Port: 34567}
	b := &Bundle{Config: c, Files: map[string][]byte{}}
	for _, name := range files {
		b.Files[name] = []byte("fixture")
	}
	b.Files["native/bundle.json"], _ = json.Marshal(c)
	r := &fakeRegistry{}
	i, err := NewInstaller(t.TempDir(), r, b)
	if err != nil {
		t.Fatal(err)
	}
	i.network = func(string) (*net.IPNet, error) { return &net.IPNet{}, nil }
	return i, r
}
func archive(t *testing.T, b *Bundle, change func(string) (string, []byte)) *bytes.Buffer {
	t.Helper()
	out := &bytes.Buffer{}
	z := zip.NewWriter(out)
	for _, name := range files {
		dest := name
		data := b.Files[name]
		if change != nil {
			var replacement []byte
			dest, replacement = change(name)
			if replacement != nil {
				data = replacement
			}
		}
		w, err := z.Create(dest)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return out
}
func TestBundleRejectsTraversalDuplicatesInvalidConfigAndCorruption(t *testing.T) {
	i, _ := fixture(t)
	good := archive(t, i.bundle, nil).Bytes()
	if _, err := ParseBundle(good); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"../outside.exe", "/absolute.exe", "extension/manifest.json", "native\\webzoom-lan-host.exe"} {
		data := archive(t, i.bundle, func(name string) (string, []byte) {
			if name == "native/webzoom-lan-host.exe" {
				return bad, nil
			}
			return name, nil
		}).Bytes()
		if _, err := ParseBundle(data); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
	data := archive(t, i.bundle, func(name string) (string, []byte) {
		if name == "native/bundle.json" {
			return name, []byte("{}")
		}
		return name, nil
	}).Bytes()
	if _, err := ParseBundle(data); err == nil {
		t.Fatal("invalid config accepted")
	}
	temp := t.TempDir()
	stub := filepath.Join(temp, "stub")
	zipfile := filepath.Join(temp, "payload.zip")
	exe := filepath.Join(temp, "setup.exe")
	os.WriteFile(stub, []byte("MZfixture"), 0600)
	os.WriteFile(zipfile, good, 0600)
	if err := AppendBundle(stub, zipfile, exe); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadBundle(exe); err != nil {
		t.Fatal(err)
	}
	if err := AppendBundle(stub, zipfile, exe); err == nil {
		t.Fatal("overwrote existing executable")
	}
	contents, _ := os.ReadFile(exe)
	contents[len(contents)-49] ^= 1
	os.WriteFile(exe, contents, 0600)
	if _, err := ReadBundle(exe); err == nil {
		t.Fatal("corruption accepted")
	}
	if _, err := ParseBundle(make([]byte, maxBundle+1)); err == nil {
		t.Fatal("oversized input accepted")
	}
}
func TestPerUserInstallUpgradeAndUninstall(t *testing.T) {
	i, r := fixture(t)
	first, err := i.Install("192.0.2.4")
	if err != nil {
		t.Fatal(err)
	}
	old := r.value
	p, ext, err := i.Installed()
	if err != nil || p.InterfaceIP != "192.0.2.4" || ext != first {
		t.Fatal(p, ext, err)
	}
	second, err := i.Install("192.0.2.5")
	if err != nil || first == second || r.value == old {
		t.Fatal(second, err)
	}
	if _, err = os.Stat(filepath.Join(filepath.Dir(old), "webzoom-lan-host.exe")); err != nil {
		t.Fatal("upgrade overwrote previous version", err)
	}
	raw, _ := os.ReadFile(r.value)
	var m hostManifest
	json.Unmarshal(raw, &m)
	if m.Allowed[0] != "chrome-extension://"+i.bundle.Config.ExtensionID+"/" {
		t.Fatal(m)
	}
	if err = i.Uninstall(); err != nil {
		t.Fatal(err)
	}
	if r.value != "" || r.deletes != 1 {
		t.Fatal(r)
	}
	entries, _ := os.ReadDir(i.root)
	if len(entries) != 0 {
		t.Fatal("known files remain", entries)
	}
}
func TestFailedUpgradePreservesOldRegistrationAndFiles(t *testing.T) {
	i, r := fixture(t)
	if _, err := i.Install("192.0.2.4"); err != nil {
		t.Fatal(err)
	}
	old := r.value
	r.failWrite = true
	if _, err := i.Install("192.0.2.5"); err == nil {
		t.Fatal("write failure ignored")
	}
	if r.value != old {
		t.Fatal("registration changed")
	}
	if _, err := os.Stat(old); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(i.root)
	if len(entries) != 1 {
		t.Fatal("failed candidate retained", entries)
	}
}
func TestForeignRegistrationAndUnknownUserFilesArePreserved(t *testing.T) {
	i, r := fixture(t)
	foreign := filepath.Join(t.TempDir(), "com.webzoom.lan.json")
	os.WriteFile(foreign, []byte("foreign"), 0600)
	r.value = foreign
	if _, err := i.Install("192.0.2.4"); err == nil {
		t.Fatal("overwrote foreign registration")
	}
	if err := i.Uninstall(); err == nil {
		t.Fatal("removed foreign registration")
	}
	if r.value != foreign || r.writes != 0 || r.deletes != 0 {
		t.Fatal(r)
	}
	r.value = ""
	dir, err := i.Install("192.0.2.4")
	if err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(dir, "user-notes.txt")
	os.WriteFile(unknown, []byte("keep"), 0600)
	if err = i.Uninstall(); err == nil {
		t.Fatal("failed to report retained unknown file")
	}
	if data, err := os.ReadFile(unknown); err != nil || string(data) != "keep" {
		t.Fatal("removed unknown file")
	}
	if r.value != "" {
		t.Fatal("native registration still active")
	}
	os.Remove(unknown)
	if err = i.Uninstall(); err != nil {
		t.Fatal("retry cannot clean retained version", err)
	}
}
func TestDemoPackagesAndNetworkChangesCannotInstall(t *testing.T) {
	i, r := fixture(t)
	i.bundle.Config.Origin = "https://127.0.0.1:8743"
	if i.bundle.Config.Validate() == nil {
		t.Fatal("localhost not marked test-only")
	}
	i.bundle.Config.TestOnly = true
	if _, err := i.Install("192.0.2.4"); err == nil {
		t.Fatal("demo installed")
	}
	if err := i.Uninstall(); err == nil {
		t.Fatal("demo uninstalled")
	}
	if r.writes != 0 || r.deletes != 0 {
		t.Fatal(r)
	}
	i.bundle.Config.Origin = "https://approved.example"
	i.bundle.Config.TestOnly = false
	i.network = func(string) (*net.IPNet, error) { return nil, errors.New("changed") }
	if _, err := i.Install("192.0.2.4"); err == nil {
		t.Fatal("installed on changed adapter")
	}
}
func TestInstallerLockIsExclusiveAndReleased(t *testing.T) {
	dir := t.TempDir()
	release, err := lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := lock(dir); err == nil {
		second()
		t.Fatal("concurrent lock allowed")
	}
	release()
	third, err := lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	third()
}
func TestLinkCannotRedirectInstallation(t *testing.T) {
	i, r := fixture(t)
	outside := t.TempDir()
	if runtime.GOOS == "windows" {
		command := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:WZ_LINK -Target $env:WZ_TARGET | Out-Null")
		command.Env = append(os.Environ(), "WZ_LINK="+i.root, "WZ_TARGET="+outside)
		if out, err := command.CombinedOutput(); err != nil {
			t.Fatalf("cannot create junction fixture: %s %v", out, err)
		}
	} else if err := os.Symlink(outside, i.root); err != nil {
		t.Fatal(err)
	}
	if _, err := i.Install("192.0.2.4"); err == nil {
		t.Fatal("followed link")
	}
	if err := i.Uninstall(); err == nil {
		t.Fatal("followed link during uninstall")
	}
	if r.writes != 0 || r.deletes != 0 {
		t.Fatal(r)
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatal("modified link target")
	}
}

func TestMissingHelperNeverReportsInstallationReady(t *testing.T) {
	i, r := fixture(t)
	if _, err := i.Install("192.0.2.4"); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(filepath.Dir(r.value), "webzoom-lan-host.exe")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := i.Installed(); err == nil {
		t.Fatal("missing helper reported ready")
	}
}
func TestLegacyInstallationIsRemovedAfterUpgrade(t *testing.T) {
	i, r := fixture(t)
	os.MkdirAll(i.root, 0700)
	legacy := filepath.Join(i.root, "com.webzoom.lan.json")
	raw, _ := json.Marshal(hostManifest{Name: "com.webzoom.lan", Type: "stdio", Path: filepath.Join(i.root, "webzoom-lan-host.exe")})
	os.WriteFile(legacy, raw, 0600)
	os.WriteFile(filepath.Join(i.root, "webzoom-lan-host.exe"), []byte("old"), 0600)
	os.WriteFile(filepath.Join(i.root, "policy.json"), []byte("old"), 0600)
	r.value = legacy
	if _, err := i.Install("192.0.2.4"); err != nil {
		t.Fatal(err)
	}
	if err := i.Uninstall(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(i.root)
	if len(entries) != 0 {
		t.Fatal("legacy files remain", entries)
	}
}
