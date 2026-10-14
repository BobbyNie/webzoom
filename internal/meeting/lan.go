package meeting

import (
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"sort"
	"strings"
	"time"
	"webzoom/internal/lan"
)

// LANConfig is opt-in. Budget covers application media egress, not line-rate TCP/TLS or ingress.
type LANConfig struct {
	Enabled    bool
	BudgetMbps int
	StreamMbps int
}
type LANCommand struct {
	Op         string `json:"op"`
	Node       string `json:"node,omitempty"`
	Token      string `json:"token,omitempty"`
	Generation string `json:"generation,omitempty"`
}
type LANState struct {
	Role       string `json:"role"`
	Node       string `json:"node"`
	Room       string `json:"room"`
	Group      string `json:"group,omitempty"`
	Generation string `json:"generation,omitempty"`
	Key        string `json:"key,omitempty"`
	Public     string `json:"public,omitempty"`
	Epoch      uint32 `json:"epoch"`
	LeaseMS    int    `json:"leaseMs"`
	Token      string `json:"token,omitempty"`
	Message    string `json:"message,omitempty"`
}
type lanPeer struct {
	node      lan.ID
	alive     time.Time
	challenge string
	probeAt   time.Time
	edges     map[string]time.Time
	state     LANState
	ack       string
}
type lanRoom struct {
	tag, generation lan.ID
	plan            string
	groups          map[string]string
}
type lanHub struct {
	signer   *ecdsa.PrivateKey
	lastTick time.Time
	credit   float64
	rateAt   time.Time
}

func (h *Hub) JoinLAN(id string, u User, session string) (*Peer, error) {
	if !h.cfg.LAN.Enabled {
		return nil, ErrForbidden
	}
	return h.join(id, u, session, true)
}
func (h *Hub) lanSlots() int { return h.cfg.LAN.BudgetMbps / h.cfg.LAN.StreamMbps }
func (h *Hub) lanUsed() int {
	n := 0
	for _, r := range h.rooms {
		for _, p := range r.peers {
			if p.User.ID != r.PublisherID && (p.lan == nil || p.lan.state.Role == "relay") {
				n++
			}
		}
	}
	return n
}
func (h *Hub) LANControl(p *Peer, c LANCommand) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[p.RoomID]
	if !h.cfg.LAN.Enabled || r == nil || r.peers[p.User.ID] != p || p.lan == nil {
		return ErrForbidden
	}
	now := h.cfg.Now()
	switch c.Op {
	case "ready":
		// Every native connection/restart forces new keys, even if it reuses the same WSS.
		p.lan.alive = now
		p.lan.edges = map[string]time.Time{}
		p.lan.ack = ""
		r.lan.plan = ""
		h.lanReplan()
	case "heartbeat":
		if p.lan.alive.IsZero() {
			return nil
		}
		p.lan.alive = now
	case "configured":
		if c.Generation == p.lan.state.Generation && c.Generation != "" {
			p.lan.ack = c.Generation
			h.keyframe(r)
		}
	case "seen":
		if len(c.Node) != 32 || len(c.Token) > 64 {
			return ErrConflict
		}
		for _, sender := range r.peers {
			if sender != p && sender.lan != nil && sender.lan.node.String() == c.Node && sender.lan.challenge == c.Token && c.Token != "" && now.Sub(sender.lan.probeAt) < 7*time.Second && !p.lan.alive.IsZero() {
				p.lan.edges[c.Node] = now
				h.lanReplan()
				break
			}
		}
	case "failed":
		p.lan.alive = time.Time{}
		p.lan.edges = nil
		p.lan.ack = ""
		h.lanReplan()
	default:
		return ErrConflict
	}
	return nil
}
func (h *Hub) lanProbe(r *room, p *Peer, now time.Time) {
	p.lan.challenge = token()
	p.lan.probeAt = now
	h.emit(p, Event{Type: "lan-probe", LAN: &LANState{Node: p.lan.node.String(), Room: r.lan.tag.String(), Token: p.lan.challenge}})
}
func (h *Hub) lanReplan() {
	if !h.cfg.LAN.Enabled {
		return
	}
	now := h.cfg.Now()
	slots := h.lanSlots()
	for _, r := range h.rooms {
		for _, p := range r.peers {
			if p.lan == nil && p.User.ID != r.PublisherID {
				slots--
			}
		}
	}
	ids := make([]string, 0, len(h.rooms))
	for id := range h.rooms {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		r := h.rooms[id]
		if r.lan.tag == (lan.ID{}) {
			r.lan.tag = lan.NewID()
		}
		nodes := []*Peer{}
		roles := map[*Peer]string{}
		assign := map[*Peer]*Peer{}
		for _, p := range r.peers {
			if p.lan == nil {
				continue
			}
			for node, at := range p.lan.edges {
				if now.Sub(at) >= 9*time.Second {
					delete(p.lan.edges, node)
				}
			}
			if p.User.ID == r.PublisherID {
				roles[p] = "publisher"
			} else if p.lan.alive.IsZero() || now.Sub(p.lan.alive) > 6*time.Second {
				roles[p] = "probing"
			} else {
				nodes = append(nodes, p)
			}
		}
		sort.Slice(nodes, func(i, j int) bool { return nodes[i].lan.node.String() < nodes[j].lan.node.String() })
		for len(assign) < len(nodes) {
			var best *Peer
			bestCount := 0
			for _, candidate := range nodes {
				if assign[candidate] != nil {
					continue
				}
				count := 0
				for _, v := range nodes {
					if assign[v] != nil {
						continue
					}
					at, ok := v.lan.edges[candidate.lan.node.String()]
					if v == candidate || (ok && now.Sub(at) < 9*time.Second) {
						count++
					}
				}
				if count > bestCount {
					best = candidate
					bestCount = count
				}
			}
			if best == nil {
				break
			}
			available := slots > 0
			if available {
				slots--
			}
			for _, v := range nodes {
				if assign[v] != nil {
					continue
				}
				at, ok := v.lan.edges[best.lan.node.String()]
				if v == best || (ok && now.Sub(at) < 9*time.Second) {
					assign[v] = best
					if !available {
						roles[v] = "unavailable"
					} else if v == best {
						roles[v] = "relay"
					} else {
						roles[v] = "receiver"
					}
				}
			}
		}
		entries := []string{fmt.Sprint(r.Epoch)}
		for p, role := range roles {
			relay := ""
			if assign[p] != nil {
				relay = assign[p].lan.node.String()
			}
			entries = append(entries, p.lan.node.String()+":"+role+":"+relay)
		}
		sort.Strings(entries)
		plan := strings.Join(entries, "|")
		if plan == r.lan.plan {
			continue
		}
		r.lan.plan = plan
		r.lan.generation = lan.NewID()
		r.lan.groups = map[string]string{}
		for p, role := range roles {
			state := LANState{Role: role, Node: p.lan.node.String(), Room: r.lan.tag.String(), Epoch: r.Epoch, Generation: r.lan.generation.String(), LeaseMS: 4000, Public: base64.StdEncoding.EncodeToString(lan.Public(h.lan.signer))}
			if role == "relay" || role == "receiver" {
				state.Group = assign[p].lan.node.String()
				key := r.lan.groups[state.Group]
				if key == "" {
					b := make([]byte, 32)
					if _, e := rand.Read(b); e != nil {
						panic(e)
					}
					key = base64.StdEncoding.EncodeToString(b)
					r.lan.groups[state.Group] = key
				}
				state.Key = key
			}
			if role == "unavailable" {
				state.Message = "LAN 媒体出口预算不足；不会自动回退直连。"
			}
			p.lan.state = state
			p.lan.ack = ""
			p.Media.Reset()
			h.emit(p, Event{Type: "lan", LAN: &state})
		}
		h.keyframe(r)
	}
}

// Called by existing authenticated socket checks; globally throttled, no detached goroutine.
func (h *Hub) LANTick() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.cfg.LAN.Enabled {
		return
	}
	now := h.cfg.Now()
	if !h.lan.lastTick.IsZero() && now.Sub(h.lan.lastTick) < time.Second {
		return
	}
	h.lan.lastTick = now
	h.lanReplan()
	for _, r := range h.rooms {
		for _, p := range r.peers {
			if p.lan == nil {
				continue
			}
			if !p.lan.alive.IsZero() && now.Sub(p.lan.alive) <= 6*time.Second {
				state := p.lan.state
				h.emit(p, Event{Type: "lan", LAN: &state})
				if p.lan.state.Role == "relay" && now.Sub(p.lan.probeAt) >= 3*time.Second {
					h.lanProbe(r, p, now)
				}
			}
		}
	}
}
func (h *Hub) lanCanSend(p *Peer, now time.Time) bool {
	return p.lan == nil || (p.lan.state.Role == "relay" && p.lan.ack == p.lan.state.Generation && now.Sub(p.lan.alive) <= 6*time.Second)
}
func (h *Hub) lanSpend(bytes int, now time.Time) bool {
	if !h.cfg.LAN.Enabled {
		return true
	}
	rate := float64(h.cfg.LAN.BudgetMbps) * 125000
	if h.lan.rateAt.IsZero() {
		h.lan.credit = rate
	} else {
		h.lan.credit += now.Sub(h.lan.rateAt).Seconds() * rate
	}
	if h.lan.credit > rate {
		h.lan.credit = rate
	}
	h.lan.rateAt = now
	if float64(bytes) > h.lan.credit {
		return false
	}
	h.lan.credit -= float64(bytes)
	return true
}

func (h *Hub) LANEnabled() bool { return h.cfg.LAN.Enabled }

// A formerly uploading direct client becomes another downstream reservation on transfer.
func (h *Hub) lanDirectAfterTransfer(changed *room, publisher string) int {
	count := 0
	for _, r := range h.rooms {
		pub := r.PublisherID
		if r == changed {
			pub = publisher
		}
		for _, p := range r.peers {
			if p.lan == nil && p.User.ID != pub {
				count++
			}
		}
	}
	return count
}

func (h *Hub) lanCongested(r *room) {
	now := h.cfg.Now()
	if !r.Active || now.Sub(r.lastFeedback) < time.Second {
		return
	}
	r.lastFeedback = now
	h.Metrics.Degraded.Add(1)
	if pub := r.peers[r.PublisherID]; pub != nil {
		h.emit(pub, Event{Type: "congestion", Level: 1})
	}
}
