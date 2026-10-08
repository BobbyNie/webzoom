// Package loadgen provides bounded measurements and VP8 samples for WSS relay tests.
package loadgen

import (
	"encoding/binary"
	"errors"
	"io"
	"sync"
	"webzoom/internal/media"
)

type Sample struct {
	Data          []byte
	Width, Height uint16
	Key           bool
}

// ReadIVF reads at most 256 MiB of a VP8 IVF stream. Playback uses the CLI frame rate.
func ReadIVF(r io.Reader) ([]Sample, error) {
	var h [32]byte
	if _, e := io.ReadFull(r, h[:]); e != nil {
		return nil, e
	}
	if string(h[:4]) != "DKIF" || binary.LittleEndian.Uint16(h[4:6]) != 0 || binary.LittleEndian.Uint16(h[6:8]) != 32 || string(h[8:12]) != "VP80" {
		return nil, errors.New("expected version 0 VP8 IVF")
	}
	w, height := binary.LittleEndian.Uint16(h[12:14]), binary.LittleEndian.Uint16(h[14:16])
	if w == 0 || height == 0 || w > 1920 || height > 1080 {
		return nil, errors.New("dimensions exceed 1080p")
	}
	var frames []Sample
	total := 0
	for {
		var fh [12]byte
		_, e := io.ReadFull(r, fh[:])
		if e == io.EOF {
			break
		}
		if e != nil {
			return nil, e
		}
		n := int(binary.LittleEndian.Uint32(fh[:4]))
		total += n
		if n == 0 || n > media.MaxFrameSize-media.HeaderSize || total > 256<<20 || len(frames) >= 100000 {
			return nil, errors.New("IVF resource limit")
		}
		data := make([]byte, n)
		if _, e = io.ReadFull(r, data); e != nil {
			return nil, e
		}
		key := data[0]&1 == 0
		if len(frames) == 0 && !key {
			return nil, errors.New("IVF must start with a keyframe")
		}
		frames = append(frames, Sample{data, w, height, key})
	}
	if len(frames) == 0 {
		return nil, errors.New("empty IVF")
	}
	return frames, nil
}

// Histogram uses 100ms upper-bound bins; the last bin is overflow, not a cap.
type Histogram struct {
	mu    sync.Mutex
	bins  [601]uint64
	total uint64
}

func (h *Histogram) Add(ms int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if ms < 0 {
		ms = 0
	}
	i := (ms + 99) / 100
	if i > 600 {
		i = 600
	}
	h.bins[i]++
	h.total++
}
func (h *Histogram) P95() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.total == 0 {
		return 0
	}
	target := (h.total*95 + 99) / 100
	var n uint64
	for i, c := range h.bins {
		n += c
		if n >= target {
			return int64(i) * 100
		}
	}
	return 60000
}
