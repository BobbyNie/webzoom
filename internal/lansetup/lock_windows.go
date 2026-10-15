package lansetup

import (
	"errors"
	"path/filepath"
	"syscall"
)

func lock(root string) (func(), error) {
	p := filepath.Join(root, "install.lock")
	if err := safePath(p); err != nil {
		return nil, err
	}
	name, err := syscall.UTF16PtrFromString(p)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL|0x04000000, 0)
	if err != nil {
		return nil, errors.New("另一个安装或卸载操作正在进行，或安装目录不可写。请稍后重试")
	}
	return func() { syscall.CloseHandle(h) }, nil
}
