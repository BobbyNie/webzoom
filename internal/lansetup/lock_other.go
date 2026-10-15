//go:build !windows

package lansetup

import (
	"os"
	"path/filepath"
)

func lock(root string) (func(), error) {
	p := filepath.Join(root, "install.lock")
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	return func() { f.Close(); os.Remove(p) }, nil
}
