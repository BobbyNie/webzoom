//go:build !windows

package lansetup

import "os"

func pathIsLink(_ string, s os.FileInfo) (bool, error) { return s.Mode()&os.ModeSymlink != 0, nil }
