package meeting

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sort"
	"sync"
	"sync/atomic"
	"time"
	"webzoom/internal/media"
)

var ErrNotFound = errors.New("meeting not found or expired")
var ErrForbidden = errors.New("operation not permitted")
var ErrCapacity = errors.New("capacity reached")
var ErrConflict = errors.New("already connected or invalid meeting state")

type User struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Snapshot struct {
	Quality      int       `json:"quality"`
	ID           string    `json:"id"`
	OwnerID      string    `json:"ownerId"`
	PublisherID  string    `json:"publisherId"`
	Epoch        uint32    `json:"epoch"`
	Active       bool      `json:"active"`
	CreatedAt    time.Time `json:"createdAt"`
	ExpiresAt    time.Time `json:"expiresAt"`
	Participants []User    `json:"participants"`
}
type Event struct {
	Type       string    `json:"type"`
	Room       *Snapshot `json:"room,omitempty"`
	Level      int       `json:"level,omitempty"`
	ServerTime int64     `json:"serverTime,omitempty"`
}
type Peer struct {
	User              User
	SessionID, RoomID string
	Events            chan Event
	Media             *media.Queue
	Done              chan struct{}
	Reason            string
}
type room struct {
	Snapshot
	peers                                      map[string]*Peer
	emptyAt, lastKey, lastFeedback, timeWindow time.Time
	lastSequence                               uint32
	hasSequence                                bool
	windowBytes                                int
}
type Config struct {
	Now                  func() time.Time
	MaxRooms, MaxViewers int // Positive values enable load-test limits; zero disables them.
}
type Metrics struct{ Ingress, Egress, Dropped, Degraded atomic.Uint64 }
type Hub struct {
	mu      sync.Mutex
	rooms   map[string]*room
	cfg     Config
	Metrics Metrics
}

func New(c Config) *Hub {
	if c.Now == nil {
		c.Now = time.Now
	}
	return &Hub{rooms: make(map[string]*room), cfg: c}
}
func token() string {
	b := make([]byte, 24)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func (h *Hub) Create(u User) (Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweep()
	if h.cfg.MaxRooms > 0 && len(h.rooms) >= h.cfg.MaxRooms {
		return Snapshot{}, ErrCapacity
	}
	now := h.cfg.Now()
	r := &room{Snapshot: Snapshot{ID: token(), OwnerID: u.ID, PublisherID: u.ID, CreatedAt: now, ExpiresAt: now.Add(8 * time.Hour)}, peers: map[string]*Peer{}, emptyAt: now}
	h.rooms[r.ID] = r
	return snapshot(r), nil
}
func snapshot(r *room) Snapshot {
	s := r.Snapshot
	s.Participants = make([]User, 0, len(r.peers))
	for _, p := range r.peers {
		s.Participants = append(s.Participants, p.User)
	}
	sort.Slice(s.Participants, func(i, j int) bool { return s.Participants[i].Name < s.Participants[j].Name })
	return s
}
func (h *Hub) room(id string) (*room, error) {
	r := h.rooms[id]
	if r == nil {
		return nil, ErrNotFound
	}
	if !h.cfg.Now().Before(r.ExpiresAt) || (!r.emptyAt.IsZero() && h.cfg.Now().Sub(r.emptyAt) >= 30*time.Minute) {
		h.end(r, "meeting expired")
		return nil, ErrNotFound
	}
	return r, nil
}
func (h *Hub) Get(id string) (Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, e := h.room(id)
	if e != nil {
		return Snapshot{}, e
	}
	return snapshot(r), nil
}

// Owned returns live meetings created by the authenticated user, newest first.
func (h *Hub) Owned(ownerID string) []Snapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweep()
	rooms := make([]Snapshot, 0)
	for _, r := range h.rooms {
		if r.OwnerID == ownerID {
			rooms = append(rooms, snapshot(r))
		}
	}
	sort.Slice(rooms, func(i, j int) bool {
		if rooms[i].CreatedAt.Equal(rooms[j].CreatedAt) {
			return rooms[i].ID < rooms[j].ID
		}
		return rooms[i].CreatedAt.After(rooms[j].CreatedAt)
	})
	return rooms
}
func (h *Hub) Join(id string, u User, session string) (*Peer, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, e := h.room(id)
	if e != nil {
		return nil, e
	}
	if r.peers[u.ID] != nil {
		return nil, ErrConflict
	}
	if h.cfg.MaxViewers > 0 && len(r.peers) >= h.cfg.MaxViewers+1 {
		return nil, ErrCapacity
	}
	p := &Peer{User: u, SessionID: session, RoomID: id, Events: make(chan Event, 32), Media: media.NewQueue(8, 2<<20), Done: make(chan struct{})}
	r.peers[u.ID] = p
	r.emptyAt = time.Time{}
	h.broadcast(r)
	h.keyframe(r)
	return p, nil
}
func (h *Hub) emit(p *Peer, e Event) {
	select {
	case <-p.Done:
		return
	default:
	}
	select {
	case p.Events <- e:
	default:
		p.Reason = "control queue overflow"
		close(p.Done)
	}
}
func (h *Hub) broadcast(r *room) {
	s := snapshot(r)
	for _, p := range r.peers {
		h.emit(p, Event{Type: "room", Room: &s})
	}
}
func (h *Hub) reset(r *room) {
	r.Epoch++
	r.Active = false
	r.Quality = 0
	r.hasSequence = false
	r.lastKey = time.Time{}
	for _, p := range r.peers {
		p.Media.Reset()
	}
}
func (h *Hub) Action(id, actor, action, target string) (Snapshot, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, e := h.room(id)
	if e != nil {
		return Snapshot{}, e
	}
	if action == "end" {
		if actor != r.OwnerID {
			return Snapshot{}, ErrForbidden
		}
		s := snapshot(r)
		h.end(r, "meeting ended")
		return s, nil
	}
	if r.peers[actor] == nil {
		return Snapshot{}, ErrForbidden
	}
	switch action {
	case "transfer":
		if actor != r.OwnerID {
			return Snapshot{}, ErrForbidden
		}
		if r.peers[target] == nil {
			return Snapshot{}, ErrConflict
		}
		h.reset(r)
		r.PublisherID = target
	case "start":
		if actor != r.PublisherID {
			return Snapshot{}, ErrForbidden
		}
		if r.Active {
			return Snapshot{}, ErrConflict
		}
		h.reset(r)
		r.Active = true
	case "stop":
		if actor != r.PublisherID {
			return Snapshot{}, ErrForbidden
		}
		h.reset(r)
	default:
		return Snapshot{}, ErrConflict
	}
	h.broadcast(r)
	return snapshot(r), nil
}
func (h *Hub) end(r *room, reason string) {
	for _, p := range r.peers {
		select {
		case <-p.Done:
		default:
			p.Reason = reason
			close(p.Done)
		}
		p.Media.Reset()
	}
	delete(h.rooms, r.ID)
}
func (h *Hub) Leave(p *Peer) { h.mu.Lock(); defer h.mu.Unlock(); h.leave(p, "disconnected") }
func (h *Hub) leave(p *Peer, reason string) {
	r := h.rooms[p.RoomID]
	if r == nil || r.peers[p.User.ID] != p {
		return
	}
	delete(r.peers, p.User.ID)
	select {
	case <-p.Done:
	default:
		p.Reason = reason
		close(p.Done)
	}
	p.Media.Reset()
	if r.PublisherID == p.User.ID {
		h.reset(r)
	}
	if len(r.peers) == 0 {
		r.emptyAt = h.cfg.Now()
	}
	h.broadcast(r)
}
func (h *Hub) RevokeSession(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.rooms {
		for _, p := range r.peers {
			if p.SessionID == id {
				h.leave(p, "session expired")
			}
		}
	}
}
func (h *Hub) sweep() {
	now := h.cfg.Now()
	for _, r := range h.rooms {
		if !now.Before(r.ExpiresAt) || (!r.emptyAt.IsZero() && now.Sub(r.emptyAt) >= 30*time.Minute) {
			h.end(r, "meeting expired")
		}
	}
}
func (h *Hub) Sweep() { h.mu.Lock(); defer h.mu.Unlock(); h.sweep() }
func (h *Hub) keyframe(r *room) {
	now := h.cfg.Now()
	if !r.Active || now.Sub(r.lastKey) < 500*time.Millisecond {
		return
	}
	p := r.peers[r.PublisherID]
	if p != nil {
		h.emit(p, Event{Type: "keyframe"})
		r.lastKey = now
	}
}
func (h *Hub) RequestKeyframe(p *Peer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rooms[p.RoomID]; r != nil && r.peers[p.User.ID] == p {
		p.Media.Reset()
		h.keyframe(r)
	}
}
func (h *Hub) Feedback(p *Peer, level int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[p.RoomID]
	if r == nil || r.peers[p.User.ID] != p || !r.Active {
		return
	}
	if level < 1 || level > 3 || h.cfg.Now().Sub(r.lastFeedback) < time.Second {
		return
	}
	r.lastFeedback = h.cfg.Now()
	h.Metrics.Degraded.Add(1)
	if pub := r.peers[r.PublisherID]; pub != nil {
		h.emit(pub, Event{Type: "congestion", Level: level})
	}
}
func (h *Hub) Publish(p *Peer, data []byte) error {
	f, e := media.Parse(data)
	if e != nil {
		return e
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r, e := h.room(p.RoomID)
	if e != nil {
		return e
	}
	if !r.Active || r.PublisherID != p.User.ID || r.peers[p.User.ID] != p || f.Epoch != r.Epoch {
		return ErrForbidden
	}
	if r.hasSequence && f.Sequence <= r.lastSequence {
		return ErrConflict
	}
	now := h.cfg.Now()
	if now.Sub(r.timeWindow) >= time.Second {
		r.timeWindow = now
		r.windowBytes = 0
	}
	r.windowBytes += len(data)
	if r.windowBytes > 16<<20 {
		return ErrCapacity
	}
	r.hasSequence = true
	r.lastSequence = f.Sequence
	h.Metrics.Ingress.Add(uint64(len(data)))
	needKey := false
	for _, v := range r.peers {
		if v == p {
			continue
		}
		if !v.Media.Push(data, f.Key) {
			h.Metrics.Dropped.Add(1)
			needKey = true
		}
	}
	if needKey {
		h.keyframe(r)
	}
	return nil
}
func (h *Hub) Counts() (rooms, connections, queued int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.rooms {
		rooms++
		connections += len(r.peers)
		for _, p := range r.peers {
			queued += p.Media.Len()
		}
	}
	return
}

func (h *Hub) ReportQuality(p *Peer, level int) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, e := h.room(p.RoomID)
	if e != nil {
		return e
	}
	if !r.Active || r.PublisherID != p.User.ID || r.peers[p.User.ID] != p {
		return ErrForbidden
	}
	if level < 0 || level > 4 {
		return ErrConflict
	}
	if r.Quality != level {
		r.Quality = level
		h.broadcast(r)
	}
	return nil
}

// QualityLevels counts active rooms, not merely congestion reports.
func (h *Hub) QualityLevels() (levels [5]int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range h.rooms {
		if r.Active {
			levels[r.Quality]++
		}
	}
	return
}
