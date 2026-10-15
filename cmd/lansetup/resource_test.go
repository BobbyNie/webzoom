package main

import (
	"bytes"
	"debug/pe"
	"os"
	"testing"
)

func TestEmbeddedManifestIsExplicitlyNonElevating(t *testing.T) {
	raw, err := os.ReadFile("setup.manifest")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("level=\"asInvoker\" uiAccess=\"false\"")) || bytes.Contains(raw, []byte("requireAdministrator")) {
		t.Fatal("missing no-elevation declaration")
	}
	object, err := pe.Open("rsrc_windows_amd64.syso")
	if err != nil {
		t.Fatal(err)
	}
	defer object.Close()
	section := object.Section(".rsrc")
	if section == nil {
		t.Fatal("missing resource section")
	}
	data, err := section.Data()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, raw) {
		t.Fatal("embedded resource differs from reviewed manifest; regenerate it")
	}
}
