// Package media implements the video-only WebZoom wire protocol and bounded queues.
package media

import (
	"encoding/binary"
	"errors"
	"sync"
)

const HeaderSize = 32
const MaxFrameSize = 1 << 20

// Frame contains one VP8 encoded video chunk. Timestamp is Unix microseconds.
// All integers on the wire use network byte order. Bytes 5..7 and 28..31 are reserved.
type Frame struct {
	Epoch, Sequence uint32
	Timestamp       uint64
	Key             bool
	Width, Height   uint16
	Payload         []byte
}

func (f Frame) Marshal() []byte {
	b := make([]byte, HeaderSize+len(f.Payload))
	copy(b, "WZ01")
	if f.Key {
		b[4] = 1
	}
	binary.BigEndian.PutUint32(b[8:12], f.Epoch)
	binary.BigEndian.PutUint32(b[12:16], f.Sequence)
	binary.BigEndian.PutUint64(b[16:24], f.Timestamp)
	binary.BigEndian.PutUint16(b[24:26], f.Width)
	binary.BigEndian.PutUint16(b[26:28], f.Height)
	copy(b[HeaderSize:], f.Payload)
	return b
}
func Parse(b []byte) (Frame, error) {
	if len(b) <= HeaderSize || len(b) > MaxFrameSize || string(b[:4]) != "WZ01" || b[4] > 1 || b[5] != 0 || b[6] != 0 || b[7] != 0 || binary.BigEndian.Uint32(b[28:32]) != 0 {
		return Frame{}, errors.New("invalid video frame")
	}
	f := Frame{Epoch: binary.BigEndian.Uint32(b[8:12]), Sequence: binary.BigEndian.Uint32(b[12:16]), Timestamp: binary.BigEndian.Uint64(b[16:24]), Key: b[4] == 1, Width: binary.BigEndian.Uint16(b[24:26]), Height: binary.BigEndian.Uint16(b[26:28]), Payload: b[HeaderSize:]}
	if f.Width == 0 || f.Height == 0 || f.Width > 1920 || f.Height > 1080 {
		return Frame{}, errors.New("unsupported video dimensions")
	}
	return f, nil
}

// Queue shares immutable payloads, never blocks publishers, and drops the entire
// dependent chain after overflow. The next accepted frame must be a key frame.
type Queue struct {
	mu                 sync.Mutex
	frames             [][]byte
	size, limit, bytes int
	waiting            bool
	Notify             chan struct{}
}

func NewQueue(frames, bytes int) *Queue {
	return &Queue{limit: frames, bytes: bytes, waiting: true, Notify: make(chan struct{}, 1)}
}
func (q *Queue) Push(b []byte, key bool) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(b) > q.bytes {
		q.reset()
		return false
	}
	if q.waiting && !key {
		return false
	}
	if len(q.frames) >= q.limit || q.size+len(b) > q.bytes {
		q.reset()
		if !key {
			return false
		}
	}
	if key {
		q.waiting = false
	}
	q.frames = append(q.frames, b)
	q.size += len(b)
	select {
	case q.Notify <- struct{}{}:
	default:
	}
	return true
}
func (q *Queue) Pop() ([]byte, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.frames) == 0 {
		return nil, false
	}
	b := q.frames[0]
	q.frames[0] = nil
	q.frames = q.frames[1:]
	q.size -= len(b)
	if len(q.frames) > 0 {
		select {
		case q.Notify <- struct{}{}:
		default:
		}
	}
	return b, true
}
func (q *Queue) reset()        { q.frames = nil; q.size = 0; q.waiting = true }
func (q *Queue) Reset()        { q.mu.Lock(); defer q.mu.Unlock(); q.reset() }
func (q *Queue) Len() int      { q.mu.Lock(); defer q.mu.Unlock(); return len(q.frames) }
func (q *Queue) Waiting() bool { q.mu.Lock(); defer q.mu.Unlock(); return q.waiting }
