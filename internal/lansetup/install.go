package lansetup

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strings"
	"webzoom/internal/lanhost"
)

type Registry interface {
	Read() (string, error)
	Write(string) error
	Delete() error
}
type Installer struct {
	root     string
	registry Registry
	bundle   *Bundle
	network  func(string) (*net.IPNet, error)
}
type hostManifest struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Path        string   `json:"path"`
	Type        string   `json:"type"`
	Allowed     []string `json:"allowed_origins"`
}

func NewInstaller(localAppData string, r Registry, b *Bundle) (*Installer, error) {
	if !filepath.IsAbs(localAppData) {
		return nil, errors.New("找不到当前用户的安装目录")
	}
	return &Installer{root: filepath.Join(localAppData, "WebZoomLAN"), registry: r, bundle: b, network: lanhost.ApprovedNetwork}, nil
}

// Refuse junctions/symlinks at every existing component before any write or removal.
func safePath(name string) error {
	name = filepath.Clean(name)
	for {
		s, err := os.Lstat(name)
		if err == nil {
			linked, checkErr := pathIsLink(name, s)
			if checkErr != nil {
				return checkErr
			}
			if linked {
				return errors.New("安装路径包含链接，请联系 IT 检查")
			}
		} else if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		parent := filepath.Dir(name)
		if parent == name {
			return nil
		}
		name = parent
	}
}
func (i *Installer) owned(manifest string) error {
	if manifest == "" {
		return nil
	}
	abs, err := filepath.Abs(manifest)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(i.root, abs)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.Base(abs) != "com.webzoom.lan.json" {
		return errors.New("已有其他位置的辅助程序注册，未修改；请联系 IT")
	}
	if err = safePath(abs); err != nil {
		return err
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return fmt.Errorf("现有注册配置无法读取，未修改：%w", err)
	}
	var m hostManifest
	if len(raw) > 8192 || json.Unmarshal(raw, &m) != nil || m.Name != "com.webzoom.lan" || m.Type != "stdio" || !strings.EqualFold(m.Path, filepath.Join(filepath.Dir(abs), "webzoom-lan-host.exe")) {
		return errors.New("现有辅助程序注册不属于此安装，未修改")
	}
	return nil
}
func AutoInterface() (string, error) {
	adapters, err := net.Interfaces()
	if err != nil {
		return "", err
	}
	for _, a := range adapters {
		if a.Flags&net.FlagUp == 0 || a.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := a.Addrs()
		if err != nil {
			return "", err
		}
		for _, addr := range addresses {
			n, ok := addr.(*net.IPNet)
			if ok && n.IP.To4() != nil {
				if _, err = lanhost.ApprovedNetwork(n.IP.String()); err == nil {
					return n.IP.String(), nil
				}
			}
		}
	}
	return "", errors.New("没有找到唯一可用的 IPv4 广播网卡。可能存在多个网卡或 VPN；请联系 IT，不要自行关闭公司 VPN。")
}
func (i *Installer) Install(ip string) (string, error) {
	if i.bundle == nil {
		return "", errors.New("安装包缺少组件")
	}
	c := i.bundle.Config
	if err := c.Validate(); err != nil {
		return "", err
	}
	if c.ConfigureOnInstall {
		return "", errors.New("请先填写会议网站和 IT 批准的 UDP 端口")
	}
	if c.TestOnly {
		return "", errors.New("这是本机演示包，禁止注册安装。请获取对应公司会议网站的正式候选包")
	}
	if _, err := i.network(ip); err != nil {
		return "", errors.New("所选网卡已改变或存在多个网卡，请重新检查")
	}
	if err := safePath(i.root); err != nil {
		return "", err
	}
	if err := os.MkdirAll(i.root, 0700); err != nil {
		return "", err
	}
	release, err := lock(i.root)
	if err != nil {
		return "", err
	}
	defer release()
	old, err := i.registry.Read()
	if err != nil {
		return "", err
	}
	if err = i.owned(old); err != nil {
		return "", err
	}
	version, err := os.MkdirTemp(i.root, "client-")
	if err != nil {
		return "", err
	}
	success := false
	defer func() {
		if !success {
			_ = removeVersion(version)
		}
	}()
	if err = os.Mkdir(filepath.Join(version, "extension"), 0700); err != nil {
		return "", err
	}
	for _, name := range files {
		dest := filepath.Join(version, filepath.FromSlash(name))
		if strings.HasPrefix(name, "native/") {
			dest = filepath.Join(version, filepath.Base(name))
		}
		if err = writeNew(dest, i.bundle.Files[name]); err != nil {
			return "", err
		}
	}
	policy := lanhost.Policy{Origin: c.Origin, ExtensionID: c.ExtensionID, InterfaceIP: ip, Port: c.Port, MaxMbps: 8}
	if err = policy.Validate("chrome-extension://" + c.ExtensionID + "/"); err != nil {
		return "", err
	}
	raw, _ := json.MarshalIndent(policy, "", "  ")
	if err = writeNew(filepath.Join(version, "policy.json"), raw); err != nil {
		return "", err
	}
	m := hostManifest{Name: "com.webzoom.lan", Description: "WebZoom approved LAN relay", Path: filepath.Join(version, "webzoom-lan-host.exe"), Type: "stdio", Allowed: []string{"chrome-extension://" + c.ExtensionID + "/"}}
	raw, _ = json.MarshalIndent(m, "", "  ")
	manifest := filepath.Join(version, "com.webzoom.lan.json")
	if err = writeNew(manifest, raw); err != nil {
		return "", err
	}
	// All payload files are durable before the single registry pointer switches. A running
	// older host is never overwritten. Previous versions are retained until explicit uninstall.
	if current, e := i.registry.Read(); e != nil || current != old {
		return "", errors.New("安装过程中注册信息改变，未覆盖；请重试")
	}
	if err = i.registry.Write(manifest); err != nil {
		return "", err
	}
	success = true
	return filepath.Join(version, "extension"), nil
}
func writeNew(p string, b []byte) error {
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
func (i *Installer) Installed() (lanhost.Policy, string, error) {
	var p lanhost.Policy
	m, err := i.registry.Read()
	if err != nil {
		return p, "", err
	}
	if m == "" {
		return p, "", errors.New("尚未安装辅助程序，请点击安装")
	}
	if err = i.owned(m); err != nil {
		return p, "", err
	}
	for _, name := range []string{"webzoom-lan-host.exe", "policy.json", "extension"} {
		candidate := filepath.Join(filepath.Dir(m), name)
		if err = safePath(candidate); err != nil {
			return p, "", err
		}
		info, checkErr := os.Stat(candidate)
		if checkErr != nil || (name == "extension" && !info.IsDir()) || (name != "extension" && !info.Mode().IsRegular()) {
			return p, "", errors.New("安装文件缺失，请点击安装 / 修复")
		}
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(m), "policy.json"))
	if err != nil {
		return p, "", err
	}
	if len(b) > 8192 || json.Unmarshal(b, &p) != nil || p.Validate("chrome-extension://"+p.ExtensionID+"/") != nil {
		return p, "", errors.New("安装配置不完整，请修复安装")
	}
	return p, filepath.Join(filepath.Dir(m), "extension"), nil
}

// Only known files in direct, non-linked client-* directories are eligible for deletion.
// Unknown user files are deliberately retained; no recursive removal is used.
func removeVersion(dir string) error {
	if err := safePath(dir); err != nil {
		return err
	}
	names := []string{"webzoom-lan-host.exe", "bundle.json", "policy.json"}
	for _, name := range files {
		if strings.HasPrefix(name, "extension/") {
			names = append(names, filepath.FromSlash(name))
		}
	}
	var result error
	for _, name := range names {
		p := filepath.Join(dir, name)
		if err := safePath(p); err != nil {
			return err
		}
		if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
			result = errors.Join(result, err)
		}
	}
	if err := os.Remove(filepath.Join(dir, "extension")); err != nil && !errors.Is(err, fs.ErrNotExist) {
		result = errors.Join(result, err)
	}
	// Preserve ownership evidence while any file is in use or any unknown file remains.
	remaining, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return result
	}
	if err != nil {
		return errors.Join(result, err)
	}
	for _, entry := range remaining {
		if entry.Name() != "com.webzoom.lan.json" {
			result = errors.Join(result, fmt.Errorf("保留尚未移除的文件：%s", entry.Name()))
		}
	}
	if result != nil {
		return result
	}
	manifest := filepath.Join(dir, "com.webzoom.lan.json")
	if err = safePath(manifest); err != nil {
		return err
	}
	if err = os.Remove(manifest); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return os.Remove(dir)
}
func (i *Installer) Uninstall() error {
	if i.bundle != nil && i.bundle.Config.TestOnly {
		return errors.New("演示包不会修改已有安装")
	}
	if err := safePath(i.root); err != nil {
		return err
	}
	if _, err := os.Stat(i.root); errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	release, err := lock(i.root)
	if err != nil {
		return err
	}
	defer release()
	current, err := i.registry.Read()
	if err != nil {
		return err
	}
	if err = i.owned(current); err != nil {
		return err
	}
	if current != "" {
		if err = i.registry.Delete(); err != nil {
			return err
		}
	}
	dirs, err := os.ReadDir(i.root)
	if err != nil {
		return err
	}
	var result error
	for _, d := range dirs {
		if d.IsDir() && strings.HasPrefix(d.Name(), "client-") {
			dir := filepath.Join(i.root, d.Name())
			m := filepath.Join(dir, "com.webzoom.lan.json")
			if err = i.owned(m); err != nil {
				result = errors.Join(result, err)
				continue
			}
			result = errors.Join(result, removeVersion(dir))
		}
	}
	// Support the previous script-only layout even after upgrading to a versioned install.
	// Keep its manifest until every known payload file is removed, so a retry remains possible.
	legacyManifest := filepath.Join(i.root, "com.webzoom.lan.json")
	if _, statErr := os.Lstat(legacyManifest); statErr == nil {
		if err = i.owned(legacyManifest); err != nil {
			return errors.Join(result, err)
		}
		var legacyError error
		for _, name := range []string{"webzoom-lan-host.exe", "policy.json"} {
			p := filepath.Join(i.root, name)
			if err = safePath(p); err != nil {
				return err
			}
			if err = os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
				legacyError = errors.Join(legacyError, err)
			}
		}
		if legacyError == nil {
			legacyError = os.Remove(legacyManifest)
		}
		result = errors.Join(result, legacyError)
	} else if !errors.Is(statErr, fs.ErrNotExist) {
		result = errors.Join(result, statErr)
	}
	if result != nil {
		return fmt.Errorf("辅助程序注册已移除；部分文件可能正在使用，请退出会议后再次卸载。扩展需通过批准渠道另行移除：%w", result)
	}
	return nil
}
