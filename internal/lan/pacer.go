package lan

import "time"

// Pacer carries debt across frame boundaries; small frames cannot reset its burst.
type Pacer struct {
	next time.Time
	Mbps int
}

func (p *Pacer) Delay(bytes int, now time.Time) time.Duration {
	floor := now.Add(-10 * time.Millisecond)
	if p.next.Before(floor) {
		p.next = floor
	}
	p.next = p.next.Add(time.Duration(float64(bytes) * 8 / float64(p.Mbps*1000000) * float64(time.Second)))
	if p.next.After(now) {
		return p.next.Sub(now)
	}
	return 0
}
