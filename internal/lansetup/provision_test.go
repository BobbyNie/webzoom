package lansetup

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func configurable(t *testing.T) *Bundle {
	t.Helper()
	i, _ := fixture(t)
	b := i.bundle
	b.Config.Origin = ""
	b.Config.Port = 0
	b.Config.ConfigureOnInstall = true
	b.Files["native/bundle.json"], _ = json.Marshal(b.Config)
	b.Files["extension/manifest.json"] = []byte(`{"manifest_version":3,"version":"0.3.0","permissions":["nativeMessaging"],"background":{"service_worker":"background.js","type":"module"}}`)
	b.Files["extension/policy.js"] = []byte("export const origin = null;")
	return b
}
func TestProvisionInstallAndNarrowPermissions(t *testing.T) {
	b := configurable(t)
	original := bytes.Clone(b.Files["extension/manifest.json"])
	if _, err := ParseBundle(archive(t, b, nil).Bytes()); err != nil {
		t.Fatal(err)
	}
	next, err := b.Provision("https://approved.example:8443", 34567)
	if err != nil {
		t.Fatal(err)
	}
	if next.Config.ConfigureOnInstall || next.Config.TestOnly || next.Config.Port != 34567 {
		t.Fatal(next.Config)
	}
	if !b.Config.ConfigureOnInstall || b.Config.Origin != "" || !bytes.Equal(original, b.Files["extension/manifest.json"]) {
		t.Fatal("template mutated")
	}
	var manifest struct {
		Permissions []string `json:"permissions"`
		Content     []struct {
			Matches []string `json:"matches"`
		} `json:"content_scripts"`
	}
	if err = json.Unmarshal(next.Files["extension/manifest.json"], &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Permissions) != 1 || manifest.Permissions[0] != "nativeMessaging" || len(manifest.Content) != 1 || len(manifest.Content[0].Matches) != 1 || manifest.Content[0].Matches[0] != "https://approved.example/*" {
		t.Fatalf("permissions: %+v", manifest)
	}
	if string(next.Files["extension/policy.js"]) != `export const origin = "https://approved.example:8443";` {
		t.Fatal("exact origin missing")
	}
	if _, err = ParseBundle(archive(t, next, nil).Bytes()); err != nil {
		t.Fatal(err)
	}
	i, r := fixture(t)
	i.bundle = next
	dir, err := i.Install("192.0.2.1")
	if err != nil {
		t.Fatal(err)
	}
	p, installed, err := i.Installed()
	if err != nil || installed != dir || p.Origin != next.Config.Origin || p.Port != 34567 || r.writes != 1 {
		t.Fatalf("installed: %+v %v", p, err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil || !bytes.Equal(raw, next.Files["extension/manifest.json"]) {
		t.Fatal("extension not provisioned")
	}
}
func TestUnconfiguredCannotInstallOrWrite(t *testing.T) {
	i, r := fixture(t)
	i.bundle = configurable(t)
	if _, err := i.Install("192.0.2.1"); err == nil {
		t.Fatal("installed unconfigured")
	}
	if r.writes != 0 {
		t.Fatal("registry changed")
	}
	if _, err := os.Stat(i.root); !os.IsNotExist(err) {
		t.Fatal("wrote installation directory")
	}
}
func TestProvisionRejectsAmbiguousOriginsAndPorts(t *testing.T) {
	b := configurable(t)
	for _, origin := range []string{"", "http://approved.example", "https://Approved.example", "https://approved.example/", "https://approved.example:443", "https://approved.example:08443", "https://approved.example:", "https://approved.example?", "https://approved.example#", "https://a@approved.example", "https://*.example", "https://例子.测试", "https://approved.example.", "https://127.0.0.1", "https://127.1", "https://2130706433", "https://0177.0.0.1", "https://0x7f000001", "https://localhost", "https://-bad.example", "https://a..example", "https://approved.example/m/abc", " https://approved.example", "https://approved.example\\evil"} {
		if _, err := b.Provision(origin, 34567); err == nil {
			t.Errorf("accepted %q", origin)
		}
	}
	for _, port := range []int{0, 1023, 65536} {
		if _, err := b.Provision("https://approved.example", port); err == nil {
			t.Fatal("accepted bad port")
		}
	}
	for _, origin := range []string{"https://approved.example", "https://xn--fsqu00a.xn--0zwm56d", "https://192.0.2.3:8443"} {
		if _, err := b.Provision(origin, 34567); err != nil {
			t.Fatal(origin, err)
		}
	}
	for _, change := range []func(*Config){func(c *Config) { c.TestOnly = true }, func(c *Config) { c.Origin = "https://approved.example" }, func(c *Config) { c.Port = 34567 }, func(c *Config) { c.ExtensionID = strings.Repeat("z", 32) }} {
		c := b.Config
		change(&c)
		if c.Validate() == nil {
			t.Fatal("accepted mixed configuration modes")
		}
	}
	b.Files["extension/manifest.json"] = []byte("null")
	if _, err := b.Provision("https://approved.example", 34567); err == nil {
		t.Fatal("accepted invalid manifest")
	}
}
