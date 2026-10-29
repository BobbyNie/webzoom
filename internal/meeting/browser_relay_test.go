package meeting

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/binary"
	"math/big"
	"strings"
	"testing"
)

func relayFixture(t *testing.T, limit int, viewers int) (*Hub, Snapshot, []*Peer) {
	t.Helper()
	return relayFixtureConfig(t, Config{BrowserRelayEnabled: true, BandwidthLimitMbps: limit}, viewers)
}
func relayFixtureConfig(t *testing.T, c Config, viewers int) (*Hub, Snapshot, []*Peer) {
	t.Helper()
	h := New(c)
	r, err := h.Create(owner)
	if err != nil {
		t.Fatal(err)
	}
	people := []*Peer{}
	for i := 0; i <= viewers; i++ {
		u := User{ID: string(rune('a' + i)), Name: "Test"}
		if i == 0 {
			u = owner
		}
		p, e := h.Join(r.ID, u, "session-"+u.ID)
		if e != nil {
			t.Fatal(e)
		}
		people = append(people, p)
		if e = h.BrowserControl(p, BrowserCommand{Kind: "hello", Capable: true}); e != nil {
			t.Fatal(e)
		}
		for _, joined := range people {
			relayPlan(joined)
		}
	}
	if !r.BrowserRelayEnabled {
		t.Fatal("new room did not enable relay by default")
	}
	return h, r, people
}
func relayStart(t *testing.T, h *Hub, r Snapshot) Snapshot {
	t.Helper()
	s, e := h.Action(r.ID, owner.ID, "start", "")
	if e != nil {
		t.Fatal(e)
	}
	return s
}
func relayPlan(p *Peer) *BrowserPlan {
	var plan *BrowserPlan
	for {
		select {
		case e := <-p.Events:
			if e.BrowserPlan != nil {
				plan = e.BrowserPlan
			}
		default:
			return plan
		}
	}
}
func TestBrowserRelayDeploymentGateAndCapacity(t *testing.T) {
	h, r, p, _ := setup(t)
	if r.BrowserRelayAvailable {
		t.Fatal("default enabled")
	}
	if _, e := h.Action(r.ID, owner.ID, "browser-relay-on", ""); e == nil {
		t.Fatal("default permits relay")
	}
	if e := h.BrowserControl(p, BrowserCommand{Kind: "hello", Capable: true}); e == nil {
		t.Fatal("default permits signaling")
	}
	h, r, people := relayFixture(t, 200, 3)
	if _, e := h.Action(r.ID, people[1].User.ID, "browser-relay-off", ""); e == nil {
		t.Fatal("nonowner toggled")
	}
	if _, e := h.Join(r.ID, User{ID: "fifth"}, "extra"); e != nil {
		t.Fatalf("fifth participant rejected: %v", e)
	}
	capped, cr, _ := relayFixtureConfig(t, Config{BrowserRelayEnabled: true, BandwidthLimitMbps: 200, BrowserRelayMaxViewers: 3}, 3)
	if _, e := capped.Join(cr.ID, User{ID: "over-cap"}, "extra"); e != ErrCapacity {
		t.Fatalf("configured cap: %v", e)
	}
	relayStart(t, h, r)
	if _, e := h.Action(r.ID, owner.ID, "browser-relay-off", ""); e != ErrConflict {
		t.Fatal("active toggle accepted")
	}
}
func TestBrowserRelaySignedFanoutAndFailover(t *testing.T) {
	h, r, p := relayFixture(t, 200, 4)
	s := relayStart(t, h, r)
	plans := []*BrowserPlan{relayPlan(p[0]), relayPlan(p[1]), relayPlan(p[2]), relayPlan(p[3]), relayPlan(p[4])}
	if plans[1].Role != "root" || len(plans[1].Links) != 3 || plans[2].Role != "peer" || plans[3].Role != "peer" || plans[4].Role != "peer" {
		t.Fatalf("bad plans %+v", plans[1])
	}
	raw := frame(s.Epoch, 1, true)
	if e := h.Publish(p[0], raw); e != nil {
		t.Fatal(e)
	}
	wire, ok := p[1].Media.Pop()
	if !ok || p[2].Media.Len() != 0 || p[3].Media.Len() != 0 || p[4].Media.Len() != 0 {
		t.Fatal("not root-only fanout")
	}
	if string(wire[:4]) != "WZP1" || string(wire[8:40]) != r.ID || binary.BigEndian.Uint32(wire[4:8]) != plans[1].Generation || !bytes.Equal(raw, wire[104:]) {
		t.Fatal("bad envelope")
	}
	signed := append(append([]byte{}, wire[:40]...), raw...)
	sum := sha256.Sum256(signed)
	if !ecdsa.Verify(&h.browser.key.PublicKey, sum[:], new(big.Int).SetBytes(wire[40:72]), new(big.Int).SetBytes(wire[72:104])) {
		t.Fatal("invalid signature")
	}
	// Revoking the root's session also rotates links and promotes a remaining viewer.
	oldGeneration := plans[2].Generation
	h.RevokeSession(p[1].SessionID)
	next := relayPlan(p[2])
	if next == nil || next.Role != "root" || next.Generation <= oldGeneration {
		t.Fatalf("failover: %+v", next)
	}
	select {
	case <-p[1].Done:
	default:
		t.Fatal("revoked root stayed connected")
	}
	if e := h.Publish(p[0], frame(s.Epoch, 2, true)); e != nil {
		t.Fatal(e)
	}
	if p[2].Media.Len() != 1 || p[3].Media.Len() != 0 || p[4].Media.Len() != 0 {
		t.Fatal("root not replaced")
	}
	if _, e := h.Action(r.ID, owner.ID, "stop", ""); e != nil {
		t.Fatal(e)
	}
	if next = relayPlan(p[2]); next.Active || len(next.Links) > 0 || p[2].Media.Len() != 0 {
		t.Fatal("stop retained media/links")
	}
}
func TestBrowserRelayFallbackBudget(t *testing.T) {
	for _, limit := range []int{20, 200} {
		h, r, p := relayFixture(t, limit, 2)
		relayStart(t, h, r)
		plan := relayPlan(p[2])
		if e := h.BrowserControl(p[2], BrowserCommand{Kind: "failed", Generation: plan.Generation}); e != nil {
			t.Fatal(e)
		}
		next := relayPlan(p[2])
		want := "direct"
		if limit == 20 {
			want = "waiting"
		}
		if next.Role != want {
			t.Fatalf("limit %d role %s", limit, next.Role)
		}
		if browserStreams(h.rooms[r.ID])*browserReservationMbps > limit {
			t.Fatal("overreserved")
		}
	}
}
func TestBrowserRelayLateRootCannotExceedBudget(t *testing.T) {
	h, r, _ := relayFixture(t, 20, 0)
	relayStart(t, h, r)
	other := User{ID: "other"}
	r2, _ := h.Create(other)
	h.Join(r2.ID, other, "other")
	if _, e := h.Action(r2.ID, other.ID, "start", ""); e != nil {
		t.Fatal(e)
	}
	p, e := h.Join(r.ID, viewer, "late")
	if e != nil {
		t.Fatal(e)
	}
	h.BrowserControl(p, BrowserCommand{Kind: "hello", Capable: true})
	if plan := relayPlan(p); plan.Role != "waiting" {
		t.Fatalf("late root over budget: %+v", plan)
	}
	if h.browserReservedExcept(nil)*browserReservationMbps > 20 {
		t.Fatal("overreserved")
	}
}

const relaySDP = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=fingerprint:sha-256 AA:BB\r\na=candidate:1 1 udp 123 192.168.1.12 49152 typ host\r\n"

func TestBrowserRelaySignalScopeAndDirection(t *testing.T) {
	h, r, p := relayFixture(t, 200, 2)
	relayStart(t, h, r)
	root := relayPlan(p[1])
	child := relayPlan(p[2])
	link := root.Links[0].ID
	send := func(peer *Peer, typ, id string, g uint32) error {
		return h.BrowserControl(peer, BrowserCommand{Kind: "signal", Signal: &BrowserSignal{Generation: g, Link: id, Type: typ, SDP: relaySDP}})
	}
	if e := send(p[2], "offer", link, child.Generation); e == nil {
		t.Fatal("child forged offer")
	}
	if e := send(p[0], "offer", link, root.Generation); e == nil {
		t.Fatal("publisher signaled unauthorized link")
	}
	if e := send(p[1], "offer", "foreign", root.Generation); e == nil {
		t.Fatal("foreign link")
	}
	if e := send(p[1], "offer", link, root.Generation-1); e != nil {
		t.Fatal("stale generation should be ignored")
	}
	if e := send(p[1], "offer", link, root.Generation); e != nil {
		t.Fatal(e)
	}
	if e := send(p[1], "offer", link, root.Generation); e == nil {
		t.Fatal("duplicate offer")
	}
	if e := send(p[2], "answer", link, root.Generation); e != nil {
		t.Fatal(e)
	}
	if !validBrowserSDP(relaySDP) {
		t.Fatal("private host rejected")
	}
	for _, bad := range []string{strings.ReplaceAll(relaySDP, "192.168.1.12", "8.8.8.8"), strings.ReplaceAll(relaySDP, "typ host", "typ relay"), strings.ReplaceAll(relaySDP, "m=application", "m=video"), relaySDP + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"} {
		if validBrowserSDP(bad) {
			t.Fatal("unsafe SDP accepted")
		}
	}
}
func TestBrowserRelayOptOutDoesNotWrapOrdinaryMedia(t *testing.T) {
	h := New(Config{BrowserRelayEnabled: true})
	r, _ := h.Create(owner)
	p, _ := h.Join(r.ID, owner, "p")
	v, _ := h.Join(r.ID, viewer, "v")
	if _, err := h.Action(r.ID, owner.ID, "browser-relay-off", ""); err != nil {
		t.Fatal(err)
	}
	s := relayStart(t, h, r)
	raw := frame(s.Epoch, 1, true)
	h.Publish(p, raw)
	wire, ok := v.Media.Pop()
	if !ok || !bytes.Equal(raw, wire) {
		t.Fatal("ordinary media changed")
	}
}
func TestBrowserRelayTransferChangesEpochAndStopsOldSource(t *testing.T) {
	h, r, p := relayFixture(t, 200, 2)
	old := relayStart(t, h, r)
	oldPlan := relayPlan(p[2])
	if _, e := h.Action(r.ID, owner.ID, "transfer", p[1].User.ID); e != nil {
		t.Fatal(e)
	}
	for _, peer := range p {
		plan := relayPlan(peer)
		if plan == nil || plan.Active || len(plan.Links) != 0 {
			t.Fatal("transfer retained old links")
		}
	}
	next, e := h.Action(r.ID, p[1].User.ID, "start", "")
	if e != nil {
		t.Fatal(e)
	}
	if next.Epoch <= old.Epoch {
		t.Fatal("epoch not advanced")
	}
	if e = h.Publish(p[0], frame(old.Epoch, 1, true)); e == nil {
		t.Fatal("old source accepted")
	}
	if e = h.BrowserControl(p[2], BrowserCommand{Kind: "failed", Generation: oldPlan.Generation}); e != nil {
		t.Fatal(e)
	}
	if p[2].browser.failed {
		t.Fatal("stale failure changed new topology")
	}
	if e = h.Publish(p[1], frame(next.Epoch, 1, true)); e != nil {
		t.Fatal(e)
	}
	r0 := h.rooms[r.ID]
	if root := r0.peers[r0.browser.root]; root == nil || root.Media.Len() != 1 || root == p[1] {
		t.Fatal("new source not delivered to distinct root")
	}
}

func TestBrowserRelayRoomDefaultAndOverrideSurviveLifecycle(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		name := "default-on"
		if !enabled {
			name = "owner-opt-out"
		}
		t.Run(name, func(t *testing.T) {
			h, r, people := relayFixture(t, 200, 2)
			if !r.BrowserRelayAvailable || !r.BrowserRelayEnabled {
				t.Fatal("deployment-enabled room requires no manual opt-in")
			}
			if !enabled {
				if _, err := h.Action(r.ID, owner.ID, "browser-relay-off", ""); err != nil {
					t.Fatal(err)
				}
			}
			check := func() {
				t.Helper()
				s, err := h.Get(r.ID)
				if err != nil || s.BrowserRelayEnabled != enabled || !s.BrowserRelayAvailable {
					t.Fatalf("room setting changed: %+v, %v", s, err)
				}
			}
			check() // Refresh reads the saved room value, not a new default.
			for i := 0; i < 2; i++ {
				if _, err := h.Action(r.ID, owner.ID, "start", ""); err != nil {
					t.Fatal(err)
				}
				check()
				if _, err := h.Action(r.ID, owner.ID, "stop", ""); err != nil {
					t.Fatal(err)
				}
				check()
			}
			next := people[1]
			if _, err := h.Action(r.ID, owner.ID, "transfer", next.User.ID); err != nil {
				t.Fatal(err)
			}
			check()
			if _, err := h.Action(r.ID, next.User.ID, "start", ""); err != nil {
				t.Fatal(err)
			}
			check()
			h.Disconnect(next)
			if _, err := h.Join(r.ID, next.User, next.SessionID); err != nil {
				t.Fatal(err)
			}
			check()
			other, err := h.Create(User{ID: "other-owner"})
			if err != nil || !other.BrowserRelayEnabled {
				t.Fatalf("room override leaked into new room: %+v, %v", other, err)
			}
		})
	}
}
