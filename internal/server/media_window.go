package server

import (
	"sync"
	"time"
)

// Acknowledgements bound browser-side pending media as well as the hub queue.
// Old clients keep the existing transport; new clients opt in on the WS URL.
const mediaWindowSize = 4

type mediaWindow struct {
	mu          sync.Mutex
	sent, acked uint64
	lastAck     time.Time
	ready       chan struct{}
}

func newMediaWindow() *mediaWindow {
	return &mediaWindow{lastAck: time.Now(), ready: make(chan struct{}, 1)}
}
func (w *mediaWindow) available() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.sent-w.acked < mediaWindowSize
}
func (w *mediaWindow) reserve() { w.mu.Lock(); w.sent++; w.mu.Unlock() }
func (w *mediaWindow) acknowledge(sequence uint64) (valid, stalled bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if sequence <= w.acked || sequence > w.sent {
		return false, false
	}
	stalled = time.Since(w.lastAck) > time.Second
	w.acked = sequence
	w.lastAck = time.Now()
	select {
	case w.ready <- struct{}{}:
	default:
	}
	return true, stalled
}
