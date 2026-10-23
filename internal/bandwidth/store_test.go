package bandwidth

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestFileStoreInitialConfigurationAndRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bandwidth.json")
	store := FileStore{Path: path}
	n, err := store.Load(200)
	if err != nil || n != 200 {
		t.Fatal(n, err)
	}
	if err := store.Save(75); err != nil {
		t.Fatal(err)
	}
	n, err = (FileStore{Path: path}).Load(900)
	if err != nil || n != 75 {
		t.Fatal("saved setting lost on restart", n, err)
	}
	if err := store.Save(300); err != nil {
		t.Fatal(err)
	}
	n, err = store.Load(200)
	if err != nil || n != 300 {
		t.Fatal(n, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// Windows Chmod supports only the owner-writable bit, not Unix group/other
	// permissions. Keep the exact 0660 assertion on Linux/Unix; do not skip the
	// persistence, replacement, corruption or cleanup checks on Windows.
	if runtime.GOOS == "windows" {
		if info.Mode().Perm()&0200 == 0 {
			t.Fatal("saved configuration is unexpectedly read-only", info.Mode())
		}
	} else if info.Mode().Perm() != 0660 {
		t.Fatal("unexpected file permissions", info.Mode())
	}
	files, _ := os.ReadDir(filepath.Dir(path))
	if len(files) != 1 {
		t.Fatal("temporary files left behind")
	}
}

func TestFileStoreRejectsCorruptOrInvalidData(t *testing.T) {
	for _, body := range []string{"", "{}", "null", `{"limitMbps":0}`, `{"limitMbps":-1}`, `{"limitMbps":1000001}`, `{"limitMbps":1.5}`, `{"limitMbps":"200"}`, `{"limitMbps":200,"extra":true}`, `{"limitMbps":200}{}`, strings.Repeat(" ", 4097)} {
		path := filepath.Join(t.TempDir(), "bandwidth.json")
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := (FileStore{Path: path}).Load(200); err == nil {
			t.Fatalf("silently accepted corrupt configuration %q", body)
		}
	}
}

func TestFileStoreSaveFailurePreservesPreviousConfiguration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bandwidth.json")
	store := FileStore{Path: path}
	if err := store.Save(100); err != nil {
		t.Fatal(err)
	}
	for _, n := range []int{0, -1, 1000001} {
		if store.Save(n) == nil {
			t.Fatal("invalid saved limit", n)
		}
	}
	if n, err := store.Load(200); err != nil || n != 100 {
		t.Fatal(n, err)
	}
	if err := (FileStore{Path: filepath.Join(dir, "missing", "file")}).Save(50); err == nil {
		t.Fatal("missing volume accepted")
	}
	if err := (FileStore{Path: dir}).Save(50); err == nil {
		t.Fatal("directory replaced")
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 1 {
		t.Fatal("temporary files left after failed rename", files)
	}
}
