package lansetup

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
)

// Archive uses a fixed file order and no wall-clock timestamps on every build OS.
func (b *Bundle) Archive() ([]byte, error) {
	var out bytes.Buffer
	z := zip.NewWriter(&out)
	for _, name := range files {
		data, ok := b.Files[name]
		if !ok {
			return nil, fmt.Errorf("missing bundle file: %s", name)
		}
		w, err := z.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err = w.Write(data); err != nil {
			return nil, err
		}
	}
	if err := z.Close(); err != nil {
		return nil, err
	}
	if _, err := ParseBundle(out.Bytes()); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

func executable(stub, archive []byte) []byte {
	sum := sha256.Sum256(archive)
	out := append(bytes.Clone(stub), archive...)
	out = append(out, sum[:]...)
	out = binary.LittleEndian.AppendUint64(out, uint64(len(archive)))
	return append(out, magic...)
}

// WriteExecutable is a deterministic build-time operation, not an installation.
func (b *Bundle) WriteExecutable(stub, target string) error {
	archive, err := b.Archive()
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(stub)
	if err != nil {
		return err
	}
	return os.WriteFile(target, executable(raw, archive), 0600)
}

// SiteExecutable narrows the embedded template to the operator's trusted origin
// and approved port. Request Host/Forwarded headers never supply either value.
func SiteExecutable(template, origin string, port int) ([]byte, error) {
	b, err := ReadBundle(template)
	if err != nil {
		return nil, err
	}
	next, err := b.Provision(origin, port)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(template)
	if err != nil {
		return nil, err
	}
	if len(raw) < footerSize {
		return nil, errors.New("invalid template")
	}
	n := binary.LittleEndian.Uint64(raw[len(raw)-16 : len(raw)-8])
	if n > maxBundle || int(n)+footerSize > len(raw) {
		return nil, errors.New("invalid template size")
	}
	archive, err := next.Archive()
	if err != nil {
		return nil, err
	}
	return executable(raw[:len(raw)-int(n)-footerSize], archive), nil
}
