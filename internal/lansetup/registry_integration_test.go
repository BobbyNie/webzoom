//go:build windows && lanintegration

package lansetup

import (
	"crypto/rand"
	"encoding/hex"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"
)

// Opt-in real HKCU test, exclusively under a fresh random TEST key, never com.webzoom.lan.
func TestUserRegistryRealIsolatedKey(t *testing.T) {
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		t.Fatal(err)
	}
	key := `Software\Google\Chrome\NativeMessagingHosts\com.webzoom.lan_test_` + hex.EncodeToString(id)
	r := UserRegistry{key: key}
	old, err := r.Read()
	if err != nil || old != "" {
		t.Fatal("test key collision", err)
	}
	defer func() {
		name, _ := syscall.UTF16PtrFromString(key)
		for _, view := range []uintptr{view32, view64} {
			code, _, _ := regDelete.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(name)), view, 0)
			if code != 0 && code != uintptr(syscall.ERROR_FILE_NOT_FOUND) {
				t.Errorf("test-key cleanup failed: %v", syscall.Errno(code))
			}
		}
	}()
	if err = r.Write("invalid\x00path"); err == nil {
		t.Fatal("invalid registry value accepted")
	}
	if read, readErr := r.Read(); readErr != nil || read != "" {
		t.Fatal("invalid value left a partial registry key", read, readErr)
	}
	value := filepath.Join(t.TempDir(), "测试 manifest.json")
	if err = r.Write(value); err != nil {
		t.Fatal(err)
	}
	read, err := r.Read()
	if err != nil || read != value {
		t.Fatal("Unicode registration round-trip failed", read, err)
	}
	value = filepath.Join(t.TempDir(), "updated.json")
	if err = r.Write(value); err != nil {
		t.Fatal(err)
	}
	read, err = r.Read()
	if err != nil || read != value {
		t.Fatal("registration upgrade failed", read, err)
	}
	if err = r.Delete(); err != nil {
		t.Fatal(err)
	}
	read, err = r.Read()
	if err != nil || read != "" {
		t.Fatal("registration uninstall failed", read, err)
	}
}
