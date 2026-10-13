package bandwidth

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

type FileStore struct{ Path string }
type fileConfig struct {
	LimitMbps int `json:"limitMbps"`
}

// Load only uses the startup value when no saved configuration exists.
// Corruption and inaccessible storage must not silently reset an administrator's limit.
func (s FileStore) Load(initial int) (int, error) {
	if !ValidLimit(initial) {
		return 0, ErrInvalidLimit
	}
	f, err := os.Open(s.Path)
	if os.IsNotExist(err) {
		return initial, nil
	}
	if err != nil {
		return 0, fmt.Errorf("cannot read bandwidth configuration: %w", err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil || len(data) > 4096 {
		return 0, fmt.Errorf("cannot read bandwidth configuration (maximum 4 KiB)")
	}
	var config fileConfig
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if d.Decode(&config) != nil || d.Decode(new(any)) != io.EOF || !ValidLimit(config.LimitMbps) {
		return 0, fmt.Errorf("invalid saved bandwidth configuration")
	}
	return config.LimitMbps, nil
}

// Save writes and syncs a complete file before an atomic rename. The caller must
// mount a persistent, writable directory. Group access supports OpenShift UIDs.
func (s FileStore) Save(limit int) error {
	if !ValidLimit(limit) {
		return ErrInvalidLimit
	}
	f, err := os.CreateTemp(filepath.Dir(s.Path), ".bandwidth-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	if err = f.Chmod(0660); err != nil {
		return err
	}
	if err = json.NewEncoder(f).Encode(fileConfig{LimitMbps: limit}); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), s.Path)
}
