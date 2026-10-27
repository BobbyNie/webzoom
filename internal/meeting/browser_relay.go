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
const browserDefaultViewers = 64
const browserHardMaxViewers = 64
const browserEnvelopeHeader = 104

type browserHub struct {
	key    *ecdsa.PrivateKey
	tokens float64
	last   time.Time
}
type browserPeer struct {
	recoveryVerifiedAt             time.Time
	recoveryVerifiedFrames         uint64
	known, capable, failed, direct bool
	recovering                     bool
	recoveryAttempts               int
	retryAt, recoveringAt          time.Time
	role, reason, parent, failure  string
	blockedParents                 map[string]bool
	report                         *BrowserReport
	rates                          *BrowserRates
	reportedAt, lastReport         time.Time
}
type browserRoom struct {
	generation uint32
	epoch      uint32
	root       string
	roots      map[string]bool
	overviewAt time.Time
	links      map[string]browserLink
}
type browserLink struct {
	root, child       string
	generation        uint32
	offered, answered bool
}
type BrowserLink struct {
	Generation uint32 `json:"generation"`
	ID         string `json:"id"`
	Peer       string `json:"peer"`
	Offerer    bool   `json:"offerer"`
}
type BrowserPlan struct {
	RoomID       string            `json:"roomId"`
	Generation   uint32            `json:"generation"`
	Epoch        uint32            `json:"epoch"`
	Active       bool              `json:"active"`
	Role         string            `json:"role"`
	Reason       string            `json:"reason"`
	Links        []BrowserLink     `json:"links"`
	PublicKey    map[string]string `json:"publicKey,omitempty"`
	ServerBackup bool              `json:"serverBackup,omitempty"`
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
	previousLinks := make(map[[2]string]struct {
		id   string
		link browserLink
	})
	if r.BrowserRelayEnabled && r.Active && r.browser.epoch == r.Epoch {
		for id, link := range r.browser.links {
			previousLinks[[2]string{link.root, link.child}] = struct {
				id   string
				link browserLink
			}{id, link}
		}
	}
	r.browser.epoch = r.Epoch
	r.browser.generation++
	r.browser.links = make(map[string]browserLink)
	plans := make(map[string]*BrowserPlan)
	ids := make([]string, 0, len(r.peers))
	for id, p := range r.peers {
		if p.browser.recovering && (r.peers[p.browser.parent] == nil || p.browser.parent == r.PublisherID) {
			p.browser.recovering = false
			p.browser.failed = true
			p.browser.retryAt = h.cfg.Now().Add(30 * time.Second)
		}
		p.browser.direct = p.browser.recovering
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
		for _, p := range r.peers {
			if p.browser.recovering {
				reserved++
			}
		}
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
		addPeer := func(id, parent string) bool {
			if !roots[parent] || counts[parent] >= browserMaxFanout || r.peers[id].browser.blockedParents[parent] {
				return false
			}
			counts[parent]++
			linkID, link := token(), browserLink{root: parent, child: id, generation: r.browser.generation}
			if old, ok := previousLinks[[2]string{parent, id}]; ok {
				linkID, link = old.id, old.link
			}
			r.browser.links[linkID] = link
			plans[id].Role = "peer"
			plans[id].Reason = "尝试同伴供流；实际办公网路径仍需核验"
			if len(r.peers[id].browser.blockedParents) > 0 {
				plans[id].Reason = "原同伴供流失败，正在尝试另一位转发者"
			}
			plans[id].Links = append(plans[id].Links, BrowserLink{ID: linkID, Peer: parent, Generation: link.generation})
			plans[parent].Links = append(plans[parent].Links, BrowserLink{ID: linkID, Peer: id, Offerer: true, Generation: link.generation})
			return true
		}
		// New assignments prefer recently verified, foreground supply. Existing
		// roots and edges stay in place regardless of ranking to avoid churn.
		score := func(id string) int {
			p := r.peers[id]
			v := p.browser.report
			if v == nil {
				return 0
			}
			age := h.cfg.Now().Sub(p.browser.reportedAt).Milliseconds()
			if age > 8000 || v.PlanFrames == 0 || v.MediaAgeMs+uint64(max(0, age)) >= 4000 {
				return -1
			}
			if v.Visibility == "visible" {
				return 2
			}
			return 1
		}
		sort.SliceStable(orderedRoots, func(i, j int) bool { return score(orderedRoots[i]) > score(orderedRoots[j]) })
		// Keep existing healthy edges before filling spare slots. A late join must
		// not reshuffle working receivers or renegotiate every data channel.
		for _, id := range ids {
			if !roots[id] {
				addPeer(id, r.peers[id].browser.parent)
			}
		}
		for _, id := range ids {
			if roots[id] || plans[id].Role == "peer" {
				continue
			}
			for _, root := range orderedRoots {
				if addPeer(id, root) {
					break
				}
			}
			if plans[id].Role != "peer" {
				if p := r.peers[id]; p.browser.recovering {
					p.browser.recovering = false
					p.browser.failed = true
					p.browser.direct = false
					reserved--
				} else {
					addRoot(id)
				}
			}
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
			plan.ServerBackup = p.browser.recovering
			if plan.ServerBackup {
				plan.Reason = "服务器继续供画面，正在验证另一位同伴；验证成功后才切换"
			}
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
		if p.browser.role != "peer" || p.browser.failed {
			return nil
		}
		wasRecovering := p.browser.recovering
		p.browser.failure = browserFailureCode(c.Failure)
		p.browser.recovering = false
		p.browser.retryAt = h.cfg.Now().Add(30 * time.Second)
		if p.browser.blockedParents == nil {
			p.browser.blockedParents = make(map[string]bool)
		}
		p.browser.blockedParents[p.browser.parent] = true
		p.browser.failed = true
		// At most three distinct failed parents per sharing epoch. Local setup or
		// key failures cannot be fixed by probing other computers.
		// A failed make-before-break probe must keep its existing server supply.
		// Other untried roots can only be probed after the recovery cooldown.
		if !wasRecovering && len(p.browser.blockedParents) < 3 && p.browser.failure != "setup_failed" && p.browser.failure != "key_import_failed" {
			for root := range r.browser.roots {
				if p.browser.blockedParents[root] {
					continue
				}
				children := 0
				for _, link := range r.browser.links {
					if link.root == root {
						children++
					}
				}
				if children < browserMaxFanout {
					p.browser.failed = false
					break
				}
			}
		}
		h.browserReplan(r)
	case "report":
		return h.browserReport(r, p, c)
	case "signal":
		s := c.Signal
		if s == nil || len(s.SDP) > 12<<10 {
			return ErrConflict
		}
		if !r.BrowserRelayEnabled || !r.Active || s.Generation > r.browser.generation {
			return nil
		}
		link, ok := r.browser.links[s.Link]
		if !ok {
			return ErrForbidden
		}
		// A retained link may finish negotiation while the room plan advances.
		if s.Generation < link.generation {
			return nil
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

// Called only from a fresh authenticated report. Keep the existing direct
// server reservation while probing a previously untried, healthy root.
func (h *Hub) browserTryRecovery(r *room, p *Peer) {
	b := &p.browser
	if b.role != "direct" || !b.capable || !b.failed || b.recoveryAttempts >= 2 || len(b.blockedParents) >= 3 || h.cfg.Now().Before(b.retryAt) {
		return
	}
	if b.failure == "setup_failed" || b.failure == "key_import_failed" || b.failure == "receive_limit" || b.failure == "invalid_fragment" {
		return
	}
	v := b.report
	if v == nil || v.Generation != r.browser.generation || v.PlanFrames == 0 || v.MediaAgeMs >= 4000 {
		return
	}
	roots := make([]string, 0, len(r.browser.roots))
	for id := range r.browser.roots {
		roots = append(roots, id)
	}
	sort.Strings(roots)
	for _, id := range roots {
		root := r.peers[id]
		if root == nil || b.blockedParents[id] {
			continue
		}
		report := root.browser.report
		age := h.cfg.Now().Sub(root.browser.reportedAt).Milliseconds()
		if report == nil || report.Generation != r.browser.generation || age > 8000 || report.PlanFrames == 0 || report.MediaAgeMs+uint64(max(0, age)) >= 4000 {
			continue
		}
		children := 0
		for _, link := range r.browser.links {
			if link.root == id {
				children++
			}
		}
		if children >= browserMaxFanout {
			continue
		}
		b.recoveryVerifiedAt = time.Time{}
		b.recoveryVerifiedFrames = 0
		b.recoveryAttempts++
		b.recovering = true
		b.recoveringAt = h.cfg.Now()
		b.failed = false
		b.parent = id
		h.browserReplan(r)
		return
	}
}
