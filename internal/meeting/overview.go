package meeting

import (
	"sort"
	"sync/atomic"
	"time"
)

type traffic struct{ ingress, egress atomic.Uint64 }

type RoomOverview struct {
	ID           string    `json:"id"`
	Active       bool      `json:"active"`
	Participants int       `json:"participants"`
	CreatedAt    time.Time `json:"createdAt"`
	ExpiresAt    time.Time `json:"expiresAt"`
	IngressBytes uint64    `json:"ingressBytes"`
	EgressBytes  uint64    `json:"egressBytes"`
}

type Overview struct {
	InstanceID   string         `json:"instanceId"`
	SampledAt    time.Time      `json:"sampledAt"`
	StartedAt    time.Time      `json:"startedAt"`
	IngressBytes uint64         `json:"ingressBytes"`
	EgressBytes  uint64         `json:"egressBytes"`
	Rooms        []RoomOverview `json:"rooms"`
}

// Overview is read-only. Counts exclude expired meetings and closing connections.
// Media counters exclude HTTP, control messages and TLS/WebSocket overhead.
func (h *Hub) Overview() Overview {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := h.cfg.Now()
	o := Overview{InstanceID: h.instanceID, SampledAt: now, StartedAt: h.startedAt, IngressBytes: h.Metrics.Ingress.Load(), EgressBytes: h.Metrics.Egress.Load(), Rooms: make([]RoomOverview, 0)}
	for _, r := range h.rooms {
		if !now.Before(r.ExpiresAt) || (!r.emptyAt.IsZero() && now.Sub(r.emptyAt) >= 30*time.Minute) {
			continue
		}
		count := 0
		for _, p := range r.peers {
			select {
			case <-p.Done:
			default:
				count++
			}
		}
		o.Rooms = append(o.Rooms, RoomOverview{ID: r.ID, Active: r.Active, Participants: count, CreatedAt: r.CreatedAt, ExpiresAt: r.ExpiresAt, IngressBytes: r.traffic.ingress.Load(), EgressBytes: r.traffic.egress.Load()})
	}
	sort.Slice(o.Rooms, func(i, j int) bool { return o.Rooms[i].ID < o.Rooms[j].ID })
	return o
}

// RecordEgress counts successful binary writes, not queued frames. The room's
// counter survives removal until its final socket writer exits, without a lock.
func (h *Hub) RecordEgress(p *Peer, size int) {
	if size <= 0 {
		return
	}
	p.traffic.egress.Add(uint64(size))
	h.Metrics.Egress.Add(uint64(size))
}
