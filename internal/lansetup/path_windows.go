package lansetup

import (
	"os"
	"syscall"
)

// Windows junctions are not consistently exposed as ModeSymlink by os.Lstat.
// Reject all reparse-point components, including mount points, before mutation.
func pathIsLink(name string, _ os.FileInfo) (bool, error) {
	p, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return false, err
	}
	attrs, err := syscall.GetFileAttributes(p)
	return attrs&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0, err
}
