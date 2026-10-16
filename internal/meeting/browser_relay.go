package meeting

// Browser relay is opt-in with bounded fanout and central bandwidth admission.
// Signalling is room/link scoped; no public ICE infrastructure is used.
import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"fmt"
	"net"
	"sort"
	"strings"
	"time"
)

const browserReservationMbps = 8
const browserMaxFanout = 3
const browserDefaultViewers = 32
const browserHardMaxViewers = 64
const browserEnvelopeHeader = 104

type browserHub struct {
	key    *ecdsa.PrivateKey
	tokens float64
	last   time.Time
}
type browserPeer struct {
	known, capable, failed, direct bool
	role, reason, parent, failure  string
	report                         *BrowserReport
	reportedAt, lastReport         time.Time
}
type browserRoom struct {
	generation uint32
	root       string
	roots      map[string]bool
	overviewAt time.Time
	links      map[string]browserLink
}
type browserLink struct {
	root, child       string
	offered, answered bool
}
type BrowserLink struct {
	ID      string `json:"id"`
	Peer    string `json:"peer"`
	Offerer bool   `json:"offerer"`
}
type BrowserPlan struct {
	RoomID     string            `json:"roomId"`
	Generation uint32            `json:"generation"`
	Epoch      uint32            `json:"epoch"`
	Active     bool              `json:"active"`
	Role       string            `json:"role"`
	Reason     string            `json:"reason"`
	Links      []BrowserLink     `json:"links"`
	PublicKey  map[string]string `json:"publicKey,omitempty"`
}
type BrowserSignal struct {
	Generation uint32 `json:"generation"`
	Link       string `json:"link"`
	Type       string `json:"type"`
	SDP        string `json:"sdp"`
}
type BrowserCommand struct {
	Kind       string         `json:"kind"`
	Capable    bool           `json:"capable"`
	Generation uint32         `json:"generation"`
	Signal     *BrowserSignal `json:"signal,omitempty"`
	Report     *BrowserReport `json:"report,omitempty"`
	Failure    string         `json:"failure,omitempty"`
}

func (h *Hub) initBrowserRelay() {
	if !h.cfg.BrowserRelayEnabled {
		return
	}
	var err error
	h.browser.key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
}
func (h *Hub) browserPublicKey() map[string]string {
	k := h.browser.key
	return map[string]string{"kty": "EC", "crv": "P-256", "x": base64.RawURLEncoding.EncodeToString(k.X.FillBytes(make([]byte, 32))), "y": base64.RawURLEncoding.EncodeToString(k.Y.FillBytes(make([]byte, 32)))}
}
func browserStreams(r *room) int {
	if !r.Active {
		return 0
	}
	n := 1 // Reserve ingress as well as media egress.
	for id, p := range r.peers {
		if id != r.PublisherID && (!r.BrowserRelayEnabled || r.browser.roots[id] || p.browser.direct) {
			n++
		}
	}
	return n
}
func (h *Hub) browserReservedExcept(except *room) int {
	n := 0
	for _, r := range h.rooms {
		if r != except {
			n += browserStreams(r)
		}
	}
	return n
}
func (h *Hub) browserBudget(extra int) bool {
	return (h.browserReservedExcept(nil)+extra)*browserReservationMbps <= h.BandwidthStatus().LimitMbps
}
func (h *Hub) browserStartAllowed(r *room) bool {
	n := len(r.peers)
	if r.BrowserRelayEnabled && n > 1 {
		n = 2
	}
	return (h.browserReservedExcept(r)+n)*browserReservationMbps <= h.BandwidthStatus().LimitMbps
}
func (h *Hub) browserReceives(r *room, p *Peer) bool {
	return !r.BrowserRelayEnabled || r.browser.roots[p.User.ID] || p.browser.direct
}

func (h *Hub) browserReplan(r *room) {
	if !h.cfg.BrowserRelayEnabled {
		return
	}
	r.browser.generation++
	r.browser.links = make(map[string]browserLink)
	plans := make(map[string]*BrowserPlan)
	ids := make([]string, 0, len(r.peers))
	for id, p := range r.peers {
		p.browser.direct = false
		if r.BrowserRelayEnabled {
			p.Media.Reset()
		}
		plans[id] = &BrowserPlan{RoomID: r.ID, Generation: r.browser.generation, Epoch: r.Epoch, Active: r.BrowserRelayEnabled && r.Active, Role: "off", Links: []BrowserLink{}}
		if id != r.PublisherID && p.browser.known && p.browser.capable && !p.browser.failed {
			ids = append(ids, id)
		}
	}
	if r.BrowserRelayEnabled && r.Active {
		sort.Strings(ids)
		reserved := h.browserReservedExcept(r) + 1
		roots := make(map[string]bool)
		counts := make(map[string]int)
		orderedRoots := []string{}
		addRoot := func(id string) bool {
			if (reserved+1)*browserReservationMbps > h.BandwidthStatus().LimitMbps {
				return false
			}
			roots[id] = true
			orderedRoots = append(orderedRoots, id)
			reserved++
			plans[id].Role = "root"
			plans[id].Reason = fmt.Sprintf("接收服务器画面并向同伴转发（每节点最多 %d 位）", browserMaxFanout)
			return true
		}
		// Retain healthy roots first. Every root consumes its own budget reservation.
		for _, id := range ids {
			if r.browser.roots[id] {
				addRoot(id)
			}
		}
		for _, id := range ids {
			if roots[id] {
				continue
			}
			parent := ""
			for _, root := range orderedRoots {
				if counts[root] < browserMaxFanout {
					parent = root
					break
				}
			}
			if parent == "" {
				addRoot(id)
				continue
			}
			counts[parent]++
			link := token()
			r.browser.links[link] = browserLink{root: parent, child: id}
			plans[id].Role = "peer"
			plans[id].Reason = "尝试同伴供流；实际办公网路径仍需核验"
			plans[id].Links = append(plans[id].Links, BrowserLink{ID: link, Peer: parent})
			plans[parent].Links = append(plans[parent].Links, BrowserLink{ID: link, Peer: id, Offerer: true})
		}
		r.browser.roots = roots
		r.browser.root = ""
		if len(orderedRoots) > 0 {
			r.browser.root = orderedRoots[0]
		}
		ordered := make([]string, 0, len(r.peers))
		for id := range r.peers {
			ordered = append(ordered, id)
		}
		sort.Strings(ordered)
		for _, id := range ordered {
			p, plan := r.peers[id], plans[id]
			plan.PublicKey = h.browserPublicKey()
			if id == r.PublisherID {
				plan.Role = "publisher"
				plan.Reason = "共享画面上传服务器"
				continue
			}
			if plan.Role == "root" || plan.Role == "peer" {
				continue
			}
			plan.Role = "waiting"
			plan.Reason = "等待可用转发节点或服务器供流额度"
			if p.browser.known && (!p.browser.capable || p.browser.failed) {
				why := browserFailureText(p.browser.failure)
				if !p.browser.capable {
					why = "浏览器不支持或不允许同伴连接"
				}
				if (reserved+1)*browserReservationMbps <= h.BandwidthStatus().LimitMbps {
					p.browser.direct = true
					reserved++
					plan.Role = "direct"
					plan.Reason = why + "；已获准服务器直连"
				} else {
					plan.Reason = why + "；服务器额度不足，已暂停画面"
				}
			}
		}
	} else {
		r.browser.root = ""
		r.browser.roots = nil
	}
	for id, plan := range plans {
		p := r.peers[id]
		p.browser.role = plan.Role
		p.browser.reason = plan.Reason
		p.browser.parent = ""
		for _, link := range plan.Links {
			if !link.Offerer {
				p.browser.parent = link.Peer
			}
		}
		h.emit(p, Event{Type: "browser-plan", BrowserPlan: plan})
	}
	h.browserOverview(r, true)
	h.keyframe(r)
}

func (h *Hub) BrowserControl(p *Peer, c BrowserCommand) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.rooms[p.RoomID]
	if !h.cfg.BrowserRelayEnabled || r == nil || r.peers[p.User.ID] != p {
		return ErrForbidden
	}
	switch c.Kind {
	case "hello":
		if p.browser.known {
			return nil
		}
		p.browser.known = true
		p.browser.capable = c.Capable
		if r.BrowserRelayEnabled {
			h.browserReplan(r)
		}
	case "failed":
		if !r.BrowserRelayEnabled || c.Generation != r.browser.generation || !r.Active {
			return nil
		}
		if p.User.ID == r.PublisherID || r.browser.roots[p.User.ID] || p.browser.failed {
			return nil
		}
		p.browser.failed = true
		p.browser.failure = browserFailureCode(c.Failure)
		h.browserReplan(r)
	case "report":
		return h.browserReport(r, p, c)
	case "signal":
		s := c.Signal
		if s == nil || len(s.SDP) > 12<<10 {
			return ErrConflict
		}
		if !r.BrowserRelayEnabled || !r.Active || s.Generation != r.browser.generation {
			return nil
		}
		link, ok := r.browser.links[s.Link]
		if !ok {
			return ErrForbidden
		}
		target := ""
		if s.Type == "offer" && p.User.ID == link.root && !link.offered {
			target = link.child
			link.offered = true
		}
		if s.Type == "answer" && p.User.ID == link.child && link.offered && !link.answered {
			target = link.root
			link.answered = true
		}
		if target == "" || !validBrowserSDP(s.SDP) {
			return ErrForbidden
		}
		r.browser.links[s.Link] = link
		if peer := r.peers[target]; peer != nil {
			copy := *s
			h.emit(peer, Event{Type: "browser-signal", BrowserSignal: &copy})
		}
	default:
		return ErrConflict
	}
	return nil
}

// Private candidates can still cross routed/VPN links. This is NOT LAN proof.
func validBrowserSDP(s string) bool {
	if len(s) == 0 || len(s) > 12<<10 {
		return false
	}
	app, fp := false, false
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "m=") {
			if app || !strings.HasPrefix(line, "m=application ") {
				return false
			}
			app = true
		}
		if strings.HasPrefix(line, "a=fingerprint:sha-256 ") {
			fp = true
		}
		if strings.HasPrefix(line, "a=candidate:") {
			fields := strings.Fields(line)
			if len(fields) < 8 || fields[1] != "1" || !strings.EqualFold(fields[2], "udp") || fields[6] != "typ" || fields[7] != "host" {
				return false
			}
			addr := fields[4]
			ip := net.ParseIP(addr)
			if !(strings.HasSuffix(addr, ".local") || ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast())) {
				return false
			}
		}
	}
	return app && fp
}
func (h *Hub) browserSign(r *room, data []byte) ([]byte, error) {
	out := make([]byte, browserEnvelopeHeader+len(data))
	copy(out, "WZP1")
	binary.BigEndian.PutUint32(out[4:8], r.browser.generation)
	copy(out[8:40], r.ID)
	copy(out[104:], data)
	hash := sha256.New()
	hash.Write(out[:40])
	hash.Write(data)
	a, b, err := ecdsa.Sign(rand.Reader, h.browser.key, hash.Sum(nil))
	if err != nil {
		return nil, err
	}
	a.FillBytes(out[40:72])
	b.FillBytes(out[72:104])
	return out, nil
}

// Service-wide fanout budget with one second of burst allowance when enabled.
// Counts ingress + queued copies, not physical NIC traffic/TLS overhead. It
// cannot undo received ingress and must not be presented as a WAN traffic shaper.
func (h *Hub) browserSpend(now time.Time, cost int) bool {
	if !h.cfg.BrowserRelayEnabled {
		return true
	}
	rate := float64(h.BandwidthStatus().LimitMbps) * 125000
	b := &h.browser
	if b.last.IsZero() {
		b.tokens = rate
	} else {
		b.tokens += max(0, now.Sub(b.last).Seconds()) * rate
	}
	b.last = now
	b.tokens = min(b.tokens, rate)
	if float64(cost) > b.tokens {
		b.tokens = 0
		return false
	}
	b.tokens -= float64(cost)
	return true
}
