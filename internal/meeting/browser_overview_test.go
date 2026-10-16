package meeting

import (
	"testing"
	"time"
)

func takeOverview(p *Peer) *BrowserOverview {
	var result *BrowserOverview
	for {
		select {
		case e := <-p.Events:
			if e.BrowserOverview != nil {
				result = e.BrowserOverview
			}
		default:
			return result
		}
	}
}
func TestBrowserRelayMultipleRootsAndCapacity(t *testing.T) {
	h, r, people := relayFixture(t, 200, 32)
	if r.BrowserRelayMaxViewers != 32 {
		t.Fatal("wrong advertised limit")
	}
	if _, err := h.Join(r.ID, User{ID: "over-limit"}, "extra"); err != ErrCapacity {
		t.Fatalf("capacity: %v", err)
	}
	active := relayStart(t, h, r)
	roots, leaves := 0, 0
	for _, p := range people[1:] {
		plan := relayPlan(p)
		switch plan.Role {
		case "root":
			roots++
			if len(plan.Links) > browserMaxFanout {
				t.Fatal("unbounded root fanout")
			}
		case "peer":
			leaves++
			if len(plan.Links) != 1 {
				t.Fatal("multiple parents")
			}
		default:
			t.Fatalf("unexpected role %s", plan.Role)
		}
	}
	if roots != 8 || leaves != 24 {
		t.Fatalf("topology roots=%d leaves=%d", roots, leaves)
	}
	if err := h.Publish(people[0], frame(active.Epoch, 1, true)); err != nil {
		t.Fatal(err)
	}
	for _, p := range people[1:] {
		want := 0
		if h.rooms[r.ID].browser.roots[p.User.ID] {
			want = 1
		}
		if p.Media.Len() != want {
			t.Fatal("center delivered to nonroot")
		}
	}
	if h.browserReservedExcept(nil)*browserReservationMbps > 200 {
		t.Fatal("over budget")
	}
}
func TestBrowserRelayMorePeopleNeverBypassBudget(t *testing.T) {
	h, r, people := relayFixture(t, 20, 8)
	relayStart(t, h, r)
	counts := map[string]int{}
	for _, p := range people[1:] {
		plan := relayPlan(p)
		counts[plan.Role]++
		if len(plan.Links) > browserMaxFanout {
			t.Fatal("fanout limit")
		}
	}
	if counts["root"] != 1 || counts["peer"] != 3 || counts["waiting"] != 4 {
		t.Fatalf("roles: %+v", counts)
	}
	if h.browserReservedExcept(nil)*browserReservationMbps > 20 {
		t.Fatal("budget exceeded")
	}
	// Remaining roots still honor the same bounds after one disappears.
	h.RevokeSession(people[1].SessionID)
	if h.browserReservedExcept(nil)*browserReservationMbps > 20 {
		t.Fatal("failover exceeded budget")
	}
	for _, p := range people[2:] {
		if plan := relayPlan(p); len(plan.Links) > browserMaxFanout {
			t.Fatal("failover fanout")
		}
	}
}
func TestBrowserReportsOwnerOnlyFreshGenerationBoundedAndAuthenticated(t *testing.T) {
	now := time.Unix(1000, 0)
	h, r, p := relayFixtureConfig(t, Config{BrowserRelayEnabled: true, BandwidthLimitMbps: 200, Now: func() time.Time { return now }}, 2)
	relayStart(t, h, r)
	plan := relayPlan(p[2])
	for _, v := range p {
		takeOverview(v)
	}
	report := BrowserReport{Generation: plan.Generation, PeerBytes: 200, VerifiedFrames: 2, PlanFrames: 2}
	command := BrowserCommand{Kind: "report", Generation: plan.Generation, Report: &report}
	now = now.Add(2 * time.Second)
	if e := h.BrowserControl(p[2], command); e != nil {
		t.Fatal(e)
	}
	v := takeOverview(p[0])
	if v == nil || len(v.Participants) != 3 {
		t.Fatal("missing owner overview")
	}
	if takeOverview(p[1]) != nil || takeOverview(p[2]) != nil {
		t.Fatal("overview leaked to other participants")
	}
	row := v.Participants[1]
	for _, x := range v.Participants {
		if x.User.ID == p[2].User.ID {
			row = x
		}
	}
	if row.Report == nil || row.Report.PeerBytes != 200 || row.Parent != p[1].User.ID || row.User.Name != p[2].User.Name {
		t.Fatalf("wrong row %+v", row)
	}
	// Copy values, not caller-owned pointers; another participant cannot forge an identity.
	report.PeerBytes = 300
	if row.Report.PeerBytes != 200 {
		t.Fatal("aliased report")
	}
	forged := &Peer{User: p[2].User, RoomID: r.ID}
	if e := h.BrowserControl(forged, command); e != ErrForbidden {
		t.Fatal("unauthenticated report accepted")
	}
	if e := h.BrowserControl(p[2], command); e != nil {
		t.Fatal(e)
	}
	if takeOverview(p[0]) != nil || p[2].browser.report.PeerBytes != 200 {
		t.Fatal("report rate limit bypassed")
	}
	now = now.Add(2 * time.Second)
	report.PeerBytes = 199
	if e := h.BrowserControl(p[2], command); e != ErrConflict {
		t.Fatal("decreasing counters accepted")
	}
	report.PeerBytes = 1 << 53
	if e := h.BrowserControl(p[2], command); e != ErrConflict {
		t.Fatal("unsafe number accepted")
	}
	report.PeerBytes = 300
	h.browserReplan(h.rooms[r.ID])
	current := takeOverview(p[0])
	if current == nil {
		t.Fatal("missing replan")
	}
	for _, x := range current.Participants {
		if x.Report != nil {
			t.Fatal("old report presented as current")
		}
	}
	if e := h.BrowserControl(p[2], command); e != nil {
		t.Fatal(e)
	}
	if takeOverview(p[0]) != nil {
		t.Fatal("old generation refreshed status")
	}
}
func TestBrowserFailureReasonsAreBoundedAndNotNetworkAccusations(t *testing.T) {
	h, r, p := relayFixture(t, 200, 2)
	relayStart(t, h, r)
	plan := relayPlan(p[2])
	if e := h.BrowserControl(p[2], BrowserCommand{Kind: "failed", Generation: plan.Generation, Failure: "media_timeout"}); e != nil {
		t.Fatal(e)
	}
	next := relayPlan(p[2])
	if next.Role != "direct" || next.Reason != browserFailureText("media_timeout")+"；已获准服务器直连" {
		t.Fatalf("reason %+v", next)
	}
	if browserFailureCode("<script>secret</script>") != "connection_failed" {
		t.Fatal("untrusted reason accepted")
	}
}

func TestBrowserRelayConfigBoundsAnd64ViewerTopology(t *testing.T) {
	for _, tc := range []struct{ configured, want int }{{0, 32}, {1, 1}, {64, 64}, {100, 64}} {
		h := New(Config{BrowserRelayMaxViewers: tc.configured})
		if h.cfg.BrowserRelayMaxViewers != tc.want {
			t.Fatalf("configured %d: got %d", tc.configured, h.cfg.BrowserRelayMaxViewers)
		}
	}
	h, r, people := relayFixtureConfig(t, Config{BrowserRelayEnabled: true, BrowserRelayMaxViewers: 64, BandwidthLimitMbps: 200}, 64)
	if r.BrowserRelayMaxViewers != 64 {
		t.Fatal("wrong advertised limit")
	}
	if _, err := h.Join(r.ID, User{ID: "over-limit"}, "extra"); err != ErrCapacity {
		t.Fatalf("capacity: %v", err)
	}
	relayStart(t, h, r)
	counts := map[string]int{}
	for _, p := range people[1:] {
		plan := relayPlan(p)
		counts[plan.Role]++
		if len(plan.Links) > browserMaxFanout {
			t.Fatal("fanout exceeded")
		}
	}
	if counts["root"] != 16 || counts["peer"] != 48 {
		t.Fatalf("roles %+v", counts)
	}
	if h.browserReservedExcept(nil)*browserReservationMbps > 200 {
		t.Fatal("budget exceeded")
	}
}

// The fourth viewer fills the third leaf slot; only the fifth viewer needs
// another central copy. These concrete expectations lock the requested fanout.
func TestBrowserRelayThreePeerBoundaryAndAdvertisedLimit(t *testing.T) {
	for _, tc := range []struct{ viewers, roots, leaves int }{
		{4, 1, 3}, {5, 2, 3}, {8, 2, 6}, {9, 3, 6},
	} {
		h, r, people := relayFixture(t, 200, tc.viewers)
		relayStart(t, h, r)
		counts := map[string]int{}
		links := 0
		for _, p := range people[1:] {
			plan := relayPlan(p)
			counts[plan.Role]++
			if plan.Role == "root" {
				if len(plan.Links) > 3 {
					t.Fatalf("%d viewers: root serves %d peers", tc.viewers, len(plan.Links))
				}
				links += len(plan.Links)
			} else if plan.Role != "peer" || len(plan.Links) != 1 {
				t.Fatalf("%d viewers: unexpected plan %+v", tc.viewers, plan)
			}
		}
		if counts["root"] != tc.roots || counts["peer"] != tc.leaves || links != tc.leaves {
			t.Fatalf("%d viewers: roles=%+v links=%d", tc.viewers, counts, links)
		}
		h.browserOverview(h.rooms[r.ID], true)
		overview := takeOverview(people[0])
		if overview == nil || overview.MaxFanout != 3 {
			t.Fatalf("%d viewers: incorrect advertised fanout: %+v", tc.viewers, overview)
		}
		if h.browserReservedExcept(nil) != tc.roots+1 {
			t.Fatalf("%d viewers: incorrect central stream reservation", tc.viewers)
		}
	}
}
