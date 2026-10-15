package lansetup

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestSiteExecutableIsDeterministicAndNarrowed(t *testing.T) {
	b := configurable(t)
	dir := t.TempDir()
	stub := filepath.Join(dir, "stub.exe")
	template := filepath.Join(dir, "template.exe")
	if err := os.WriteFile(stub, []byte("MZ-test-stub"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := b.WriteExecutable(stub, template); err != nil {
		t.Fatal(err)
	}
	original, _ := os.ReadFile(template)
	one, err := SiteExecutable(template, "https://approved.example:8443", 34567)
	if err != nil {
		t.Fatal(err)
	}
	two, err := SiteExecutable(template, "https://approved.example:8443", 34567)
	if err != nil || !bytes.Equal(one, two) {
		t.Fatal("non-deterministic", err)
	}
	target := filepath.Join(dir, "site.exe")
	os.WriteFile(target, one, 0600)
	next, err := ReadBundle(target)
	if err != nil {
		t.Fatal(err)
	}
	if next.Config.ConfigureOnInstall || next.Config.Origin != "https://approved.example:8443" || next.Config.Port != 34567 {
		t.Fatal(next.Config)
	}
	if !bytes.HasPrefix(one, []byte("MZ-test-stub")) {
		t.Fatal("stub changed")
	}
	after, _ := os.ReadFile(template)
	if !bytes.Equal(original, after) {
		t.Fatal("template mutated")
	}
	if _, err = SiteExecutable(template, "https://evil.example/path", 34567); err == nil {
		t.Fatal("invalid origin accepted")
	}
	if _, err = SiteExecutable(template, "https://approved.example", 0); err == nil {
		t.Fatal("unapproved port accepted")
	}
}
