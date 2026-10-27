package meeting

import (
	"fmt"
	"testing"
	"time"
)

func recoveryFixture(t *testing.T) (*Hub, *room, []*Peer, *Peer, *time.Time) {
	t.Helper()
	now := time.Unix(10000, 0)
	h, s, people := relayFixtureConfig(t, Config{BrowserRelayEnabled: true, BandwidthLimitMbps: 200, Now: func() time.Time { return now }}, 8)
	relayStart(t, h, s)
	r := h.rooms[s.ID]
	victim := people[2]
	for _, p := range people {
		relayPlan(p)
	}
	if err := h.BrowserControl(victim, BrowserCommand{Kind: "failed", Generation: r.browser.generation, Failure: "peer_stalled"}); err != nil {
		t.Fatal(err)
	}
	if victim.browser.role != "direct" {
		t.Fatalf("need direct: %s", victim.browser.role)
	}
	// Fill the vacant original slot, then create one new root with spare capacity.
	for i := 0; i < 2; i++ {
		p, e := h.Join(r.ID, User{ID: fmt.Sprintf("new-%d", i), Name: "new"}, fmt.Sprintf("new-session-%d", i))
		if e != nil {
			t.Fatal(e)
		}
		people = append(people, p)
		if e = h.BrowserControl(p, BrowserCommand{Kind: "hello", Capable: true}); e != nil {
			t.Fatal(e)
		}
		for _, other := range people {
			relayPlan(other)
		}
	}
	return h, r, people, victim, &now
}
func recoveryReport(t *testing.T, h *Hub, r *room, p *Peer, peerFrames uint64) {
	t.Helper()
	v := &BrowserReport{Generation: r.browser.generation, CenterBytes: 10000, PeerBytes: 10000, VerifiedFrames: 100, PlanFrames: 10, PeerPlanFrames: peerFrames, Visibility: "visible"}
	if e := h.BrowserControl(p, BrowserCommand{Kind: "report", Generation: r.browser.generation, Report: v}); e != nil {
		t.Fatal(e)
	}
}
func readyRecoveryRoots(t *testing.T, h *Hub, r *room) {
	t.Helper()
	for id := range r.browser.roots {
		recoveryReport(t, h, r, r.peers[id], 0)
	}
}
func TestBrowserRecoveryKeepsServerUntilValidatedPeerReport(t *testing.T) {
	h, r, _, p, now := recoveryFixture(t)
	*now = now.Add(29 * time.Second)
	readyRecoveryRoots(t, h, r)
	recoveryReport(t, h, r, p, 0)
	if p.browser.recovering {
		t.Fatal("retry before cooldown")
	}
	*now = now.Add(2 * time.Second)
	recoveryReport(t, h, r, p, 0)
	plan := relayPlan(p)
	if !p.browser.recovering || !p.browser.direct || !plan.ServerBackup || plan.Role != "peer" || !h.browserReceives(r, p) {
		t.Fatalf("unsafe probe %+v %+v", p.browser, plan)
	}
	if h.browserReservedExcept(nil)*browserReservationMbps > 200 {
		t.Fatal("probe exceeded budget")
	}
	parent := p.browser.parent
	*now = now.Add(time.Second)
	recoveryReport(t, h, r, p, 3)
	if !p.browser.direct {
		t.Fatal("cut server before minimum verification interval")
	}
	oldGeneration := r.browser.generation
	*now = now.Add(2 * time.Second)
	recoveryReport(t, h, r, p, 6)
	if p.browser.recovering || p.browser.direct || h.browserReceives(r, p) || p.browser.role != "peer" || p.browser.parent != parent {
		t.Fatal("did not safely commit verified peer")
	}
	if r.browser.generation != oldGeneration+1 {
		t.Fatal("unexpected replan churn")
	}
}
func TestBrowserFailedRecoveryKeepsDirectAndBoundsAttempts(t *testing.T) {
	h, r, _, p, now := recoveryFixture(t)
	*now = now.Add(31 * time.Second)
	readyRecoveryRoots(t, h, r)
	recoveryReport(t, h, r, p, 0)
	if !p.browser.recovering {
		t.Fatal("missing recovery")
	}
	generation := r.browser.generation
	if e := h.BrowserControl(p, BrowserCommand{Kind: "failed", Generation: generation, Failure: "connection_timeout"}); e != nil {
		t.Fatal(e)
	}
	if p.browser.recovering || !p.browser.direct || p.browser.role != "direct" {
		t.Fatal("failed probe lost server supply")
	}
	*now = now.Add(31 * time.Second)
	readyRecoveryRoots(t, h, r)
	p.browser.recoveryAttempts = 2
	recoveryReport(t, h, r, p, 0)
	if p.browser.recovering {
		t.Fatal("attempt limit ignored")
	}
	if e := h.BrowserControl(p, BrowserCommand{Kind: "report", Generation: generation, Report: &BrowserReport{Generation: generation, PeerPlanFrames: 100}}); e != nil {
		t.Fatal(e)
	}
	if !p.browser.direct {
		t.Fatal("old generation cut server")
	}
}
func TestBrowserRecoveryParentDepartureReturnsToDirect(t *testing.T) {
	h, r, _, p, now := recoveryFixture(t)
	*now = now.Add(31 * time.Second)
	readyRecoveryRoots(t, h, r)
	recoveryReport(t, h, r, p, 0)
	parent := r.peers[p.browser.parent]
	if !p.browser.recovering {
		t.Fatal("missing recovery")
	}
	h.RevokeSession(parent.SessionID)
	if p.browser.recovering || !p.browser.direct || p.browser.role != "direct" {
		t.Fatalf("parent departure lost fallback: %+v", p.browser)
	}
}
func TestBrowserReportsRejectInvalidSharingAndUnsafeProbeCounters(t *testing.T) {
	h, s, p := relayFixture(t, 200, 2)
	relayStart(t, h, s)
	r := h.rooms[s.ID]
	for _, v := range []*BrowserReport{
		{CenterBytes: 1, Sharing: &BrowserBytes{CenterBytes: 2}},
		{PeerPlanFrames: 1 << 53}, {PeerMediaAgeMs: 1 << 53},
	} {
		v.Generation = r.browser.generation
		if e := h.BrowserControl(p[2], BrowserCommand{Kind: "report", Generation: v.Generation, Report: v}); e != ErrConflict {
			t.Fatalf("invalid report accepted: %v", e)
		}
	}
	for _, code := range []string{"connection_timeout", "peer_no_media", "peer_stalled"} {
		if browserFailureCode(code) != code || browserFailureText(code) == browserFailureText("") {
			t.Fatal("missing diagnostic", code)
		}
	}
}
func TestBrowserNewPeerPrefersFreshSupplyWithoutMovingHealthyEdges(t *testing.T) {
	now := time.Unix(1000, 0)
	h, s, p := relayFixtureConfig(t, Config{BrowserRelayEnabled: true, BandwidthLimitMbps: 200, Now: func() time.Time { return now }}, 8)
	relayStart(t, h, s)
	r := h.rooms[s.ID]
	h.RevokeSession(p[2].SessionID)
	h.RevokeSession(p[6].SessionID)
	for _, root := range []*Peer{p[1], p[5]} {
		visibility := "hidden"
		if root == p[5] {
			visibility = "visible"
		}
		e := h.BrowserControl(root, BrowserCommand{Kind: "report", Generation: r.browser.generation, Report: &BrowserReport{Generation: r.browser.generation, PlanFrames: 1, VerifiedFrames: 1, Visibility: visibility}})
		if e != nil {
			t.Fatal(e)
		}
	}
	before := map[[2]string]string{}
	for id, l := range r.browser.links {
		before[[2]string{l.root, l.child}] = id
	}
	newcomer, e := h.Join(r.ID, User{ID: "quality-new"}, "quality-session")
	if e != nil {
		t.Fatal(e)
	}
	if e = h.BrowserControl(newcomer, BrowserCommand{Kind: "hello", Capable: true}); e != nil {
		t.Fatal(e)
	}
	if newcomer.browser.parent != p[5].User.ID {
		t.Fatalf("did not prefer fresh foreground root: %s", newcomer.browser.parent)
	}
	for pair, id := range before {
		found := false
		for nextID, l := range r.browser.links {
			if l.root == pair[0] && l.child == pair[1] && id == nextID {
				found = true
			}
		}
		if !found {
			t.Fatal("reshuffled a healthy edge", pair)
		}
	}
}

func TestBrowserFailedProbeDoesNotImmediatelyCutServerForAnotherRoot(t *testing.T) {
	h, r, people, p, now := recoveryFixture(t)
	*now = now.Add(31 * time.Second)
	readyRecoveryRoots(t, h, r)
	recoveryReport(t, h, r, p, 0)
	if !p.browser.recovering {
		t.Fatal("missing recovery")
	}
	// Free a slot on a third, untried root while the current probe is active.
	var spare *Peer
	for _, child := range people {
		if child.browser.role == "peer" && child != p && child.browser.parent != p.browser.parent && !p.browser.blockedParents[child.browser.parent] {
			spare = child
			break
		}
	}
	if spare == nil {
		t.Fatal("fixture needs another root to offer a spare slot")
	}
	h.RevokeSession(spare.SessionID)
	if !p.browser.recovering || !p.browser.direct {
		t.Fatal("membership change lost probe backup")
	}
	if err := h.BrowserControl(p, BrowserCommand{Kind: "failed", Generation: r.browser.generation, Failure: "peer_no_media"}); err != nil {
		t.Fatal(err)
	}
	if p.browser.role != "direct" || !p.browser.direct || p.browser.recovering || !p.browser.failed {
		t.Fatalf("failed probe immediately cut server for another unverified peer: %+v", p.browser)
	}
	*now = now.Add(time.Second)
	readyRecoveryRoots(t, h, r)
	recoveryReport(t, h, r, p, 0)
	if p.browser.recovering || !p.browser.direct {
		t.Fatal("failed probe skipped recovery cooldown")
	}
}
