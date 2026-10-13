// Package bandwidth implements the service-wide media admission policy.
package bandwidth

import (
	"errors"
	"sync"
	"time"
)

const (
	DefaultLimitMbps = 200
	MaxLimitMbps     = 1000000
	windowSeconds    = 5
	bucketDuration   = 100 * time.Millisecond
	bucketCount      = 50
)

var ErrInvalidLimit = errors.New("limitMbps must be an integer between 1 and 1000000")
var ErrSave = errors.New("cannot save bandwidth configuration")

type Status struct {
	LimitMbps     int     `json:"limitMbps"`
	TotalMbps     float64 `json:"totalMbps"`
	Blocked       bool    `json:"blocked"`
	WindowSeconds int     `json:"windowSeconds"`
}

type bucket struct {
	tick  int64
	bytes uint64
}
type Limiter struct {
	mu       sync.Mutex
	updateMu sync.Mutex
	limit    int
	buckets  [bucketCount]bucket
	save     func(int) error
}

func ValidLimit(n int) bool { return n >= 1 && n <= MaxLimitMbps }

func New(limit int, save func(int) error) *Limiter {
	if limit == 0 {
		limit = DefaultLimitMbps
	}
	if !ValidLimit(limit) {
		panic(ErrInvalidLimit)
	}
	return &Limiter{limit: limit, save: save}
}

// Record uses fixed storage. The rolling window has 100 ms resolution.
func (l *Limiter) Record(now time.Time, bytes uint64) {
	tick := now.UnixNano() / int64(bucketDuration)
	slot := ((tick % bucketCount) + bucketCount) % bucketCount
	l.mu.Lock()
	defer l.mu.Unlock()
	b := &l.buckets[slot]
	if b.tick != tick {
		*b = bucket{tick: tick}
	}
	b.bytes += bytes
}

func (l *Limiter) Status(now time.Time) Status {
	tick := now.UnixNano() / int64(bucketDuration)
	l.mu.Lock()
	defer l.mu.Unlock()
	var bytes uint64
	for _, b := range l.buckets {
		if age := tick - b.tick; age >= 0 && age < bucketCount {
			bytes += b.bytes
		}
	}
	return Status{LimitMbps: l.limit, TotalMbps: float64(bytes) * 8 / (windowSeconds * 1000000), Blocked: bytes > uint64(l.limit)*625000, WindowSeconds: windowSeconds}
}

// SetLimit serializes saves without holding the media accounting lock.
// A failed save never changes the effective policy.
func (l *Limiter) SetLimit(now time.Time, limit int) (Status, error) {
	if !ValidLimit(limit) {
		return Status{}, ErrInvalidLimit
	}
	l.updateMu.Lock()
	defer l.updateMu.Unlock()
	if l.save != nil {
		if err := l.save(limit); err != nil {
			return Status{}, ErrSave
		}
	}
	l.mu.Lock()
	l.limit = limit
	l.mu.Unlock()
	return l.Status(now), nil
}
