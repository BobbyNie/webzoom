// Package lansetup installs a per-user native host. It never changes firewall or Chrome policy.
package lansetup

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/url"
	"os"
	"webzoom/internal/lanhost"
)

const magic = "WZSETUP1"
const footerSize = 48
const maxBundle = 32 << 20

var files = []string{"native/webzoom-lan-host.exe", "native/bundle.json", "extension/manifest.json", "extension/background.js", "extension/content.js", "extension/policy.js", "extension/popup.html", "extension/popup.js", "extension/messages.js", "extension/diagnostic-client.js"}

type Config struct {
	Origin      string `json:"origin"`
	ExtensionID string `json:"extensionId"`
	Port        int    `json:"port"`
	TestOnly    bool   `json:"testOnly"`
}
type Bundle struct {
	Config Config
	Files  map[string][]byte
}

func (c Config) Validate() error {
	p := lanhost.Policy{Origin: c.Origin, ExtensionID: c.ExtensionID, Port: c.Port, InterfaceIP: "192.0.2.1", MaxMbps: 8}
	if p.Validate("chrome-extension://"+c.ExtensionID+"/") != nil {
		return errors.New("安装包的网站、扩展 ID 或端口配置无效")
	}
	u, _ := url.Parse(c.Origin)
	if (u.Hostname() == "localhost" || net.ParseIP(u.Hostname()).IsLoopback()) && !c.TestOnly {
		return errors.New("本机测试网站必须标记为测试包")
	}
	return nil
}

// A PE overlay is checked before extraction. This detects corruption, NOT publisher identity.
// Only unsigned development packages are produced; distribution still requires IT approval.
func ReadBundle(exe string) (*Bundle, error) {
	f, err := os.Open(exe)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if st.Size() < footerSize {
		return nil, errors.New("安装包不完整，请重新获取")
	}
	tail := make([]byte, footerSize)
	if _, err = f.ReadAt(tail, st.Size()-footerSize); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint64(tail[32:40])
	if string(tail[40:]) != magic || size == 0 || size > maxBundle || int64(size) > st.Size()-footerSize {
		return nil, errors.New("安装包格式无效")
	}
	data := make([]byte, int(size))
	if _, err = f.ReadAt(data, st.Size()-footerSize-int64(size)); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(data)
	if !bytes.Equal(sum[:], tail[:32]) {
		return nil, errors.New("安装包校验失败，请重新获取")
	}
	return ParseBundle(data)
}
func ParseBundle(data []byte) (*Bundle, error) {
	if len(data) > maxBundle {
		return nil, errors.New("安装包过大")
	}
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, name := range files {
		allowed[name] = true
	}
	if len(z.File) != len(files) {
		return nil, errors.New("安装包文件清单不符")
	}
	b := &Bundle{Files: map[string][]byte{}}
	total := uint64(0)
	for _, f := range z.File {
		if !allowed[f.Name] || b.Files[f.Name] != nil || !f.Mode().IsRegular() {
			return nil, errors.New("安装包包含重复或不允许的文件")
		}
		total += f.UncompressedSize64
		if f.UncompressedSize64 > maxBundle || total > maxBundle {
			return nil, errors.New("安装包解压大小超限")
		}
		r, err := f.Open()
		if err != nil {
			return nil, err
		}
		v, err := io.ReadAll(io.LimitReader(r, maxBundle+1))
		r.Close()
		if err != nil {
			return nil, err
		}
		if uint64(len(v)) != f.UncompressedSize64 {
			return nil, errors.New("安装包文件大小不符")
		}
		b.Files[f.Name] = v
	}
	if len(b.Files["native/bundle.json"]) > 8192 || json.Unmarshal(b.Files["native/bundle.json"], &b.Config) != nil {
		return nil, errors.New("安装配置无法读取")
	}
	if err := b.Config.Validate(); err != nil {
		return nil, err
	}
	return b, nil
}

// AppendBundle is used by the packager, never during installation.
func AppendBundle(stub, archive, target string) error {
	b, err := os.ReadFile(archive)
	if err != nil {
		return err
	}
	if _, err = ParseBundle(b); err != nil {
		return err
	}
	s, err := os.Open(stub)
	if err != nil {
		return err
	}
	defer s.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err = io.Copy(out, s); err != nil {
		return err
	}
	if _, err = out.Write(b); err != nil {
		return err
	}
	sum := sha256.Sum256(b)
	tail := make([]byte, footerSize)
	copy(tail, sum[:])
	binary.LittleEndian.PutUint64(tail[32:40], uint64(len(b)))
	copy(tail[40:], magic)
	if _, err = out.Write(tail); err != nil {
		return err
	}
	return out.Sync()
}
