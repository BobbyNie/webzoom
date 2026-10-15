package lansetup

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

const registryKey = `Software\Google\Chrome\NativeMessagingHosts\com.webzoom.lan`
const view64 = 0x0100
const view32 = 0x0200

type UserRegistry struct{ key string }

func (r UserRegistry) keyName() string {
	if r.key != "" {
		return r.key
	}
	return registryKey
}

var advapi = syscall.NewLazyDLL("advapi32.dll")
var regCreate = advapi.NewProc("RegCreateKeyExW")
var regSet = advapi.NewProc("RegSetValueExW")
var regDelete = advapi.NewProc("RegDeleteKeyExW")

func regRead(keyName string, view uint32) (string, error) {
	name, _ := syscall.UTF16PtrFromString(keyName)
	var key syscall.Handle
	err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, name, 0, syscall.KEY_QUERY_VALUE|view, &key)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	defer syscall.RegCloseKey(key)
	var kind, n uint32
	if err = syscall.RegQueryValueEx(key, nil, nil, &kind, nil, &n); errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return "", errors.New("存在未完成的辅助程序注册，请联系 IT 检查")
	}
	if err != nil {
		return "", err
	}
	if kind != syscall.REG_SZ || n < 2 || n > 65536 || n%2 != 0 {
		return "", errors.New("辅助程序注册类型或长度不正确")
	}
	data := make([]uint16, n/2)
	if err = syscall.RegQueryValueEx(key, nil, nil, &kind, (*byte)(unsafe.Pointer(&data[0])), &n); err != nil {
		return "", err
	}
	if data[len(data)-1] != 0 {
		return "", errors.New("辅助程序注册无效")
	}
	return syscall.UTF16ToString(data), nil
}
func (r UserRegistry) Read() (string, error) {
	// Chrome checks the 32-bit view first. Never silently hide or overwrite another registration.
	other, err := regRead(r.keyName(), view32)
	if err != nil {
		return "", err
	}
	current, err := regRead(r.keyName(), view64)
	if err != nil {
		return "", err
	}
	// HKCU can expose the same key in both views. Only a DIFFERENT 32-bit value shadows it.
	if other != "" && other != current {
		return "", errors.New("存在 32 位辅助程序注册，安装程序未修改它。请联系 IT 统一安装来源")
	}
	return current, nil
}
func (r UserRegistry) Write(value string) error {
	data, err := syscall.UTF16FromString(value)
	if err != nil {
		return err
	}
	if _, err := r.Read(); err != nil {
		return err
	}
	name, _ := syscall.UTF16PtrFromString(r.keyName())
	var key syscall.Handle
	code, _, _ := regCreate.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(name)), 0, 0, 0, syscall.KEY_SET_VALUE|view64, 0, uintptr(unsafe.Pointer(&key)), 0)
	if code != 0 {
		return syscall.Errno(code)
	}
	defer syscall.RegCloseKey(key)
	code, _, _ = regSet.Call(uintptr(key), 0, 0, syscall.REG_SZ, uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)*2))
	if code != 0 {
		return fmt.Errorf("写入当前用户注册失败：%w", syscall.Errno(code))
	}
	return nil
}
func (r UserRegistry) Delete() error {
	if _, err := r.Read(); err != nil {
		return err
	}
	name, _ := syscall.UTF16PtrFromString(r.keyName())
	code, _, _ := regDelete.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(name)), view64, 0)
	if code == 0 || code == uintptr(syscall.ERROR_FILE_NOT_FOUND) {
		return nil
	}
	return syscall.Errno(code)
}
