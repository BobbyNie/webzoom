package meeting

import (
	"testing"
	"time"
)

func TestBrowserRelayRetainsEdgesAndInFlightSignalsAcrossLateJoin(t *testing.T) {
	h, r, p := relayFixture(t, 200, 3)
	relayStart(t, h, r)
	child := relayPlan(p[2])
	original := child.Links[0]
	late, err := h.Join(r.ID, User{ID: "z-late", Name: "Late viewer"}, "late-session")
	if err != nil {
		t.Fatal(err)
	}
	if err = h.BrowserControl(late, BrowserCommand{Kind: "hello", Capable: true}); err != nil {
		t.Fatal(err)
	}
	next := relayPlan(p[2])
	if next.Generation <= child.Generation || next.Links[0].ID != original.ID || next.Links[0].Generation != original.Generation {
		t.Fatalf("healthy edge renegotiated: before=%+v after=%+v", child, next)
	}
	signal := &BrowserSignal{Generation: child.Generation, Link: original.ID, Type: "offer", SDP: relaySDP}
	if err = h.BrowserControl(p[1], BrowserCommand{Kind: "signal", Signal: signal}); err != nil {
		t.Fatalf("in-flight offer rejected: %v", err)
	}
	retained := h.rooms[r.ID].browser.links[original.ID]
	if !retained.offered {
		t.Fatal("retained negotiation did not advance")
	}
	// An unrelated replan must retain replay protection too.
	h.browserReplan(h.rooms[r.ID])
	if err = h.BrowserControl(p[1], BrowserCommand{Kind: "signal", Signal: signal}); err != ErrForbidden {
		t.Fatalf("replayed offer accepted: %v", err)
	}
	signal.Type = "answer"
	if err = h.BrowserControl(p[2], BrowserCommand{Kind: "signal", Signal: signal}); err != nil {
		t.Fatalf("in-flight answer rejected: %v", err)
	}
}

func TestBrowserRelayTriesSpareParentThenFallsBackWithoutBudgetBypass(t *testing.T) {
	h, r, p := relayFixture(t, 200, 5)
	relayStart(t, h, r)
	first := relayPlan(p[2])
	fail := func(generation uint32) {
		t.Helper()
		if err := h.BrowserControl(p[2], BrowserCommand{Kind: "failed", Generation: generation, Failure: "media_timeout"}); err != nil {
			t.Fatal(err)
		}
	}
	fail(first.Generation)
	second := relayPlan(p[2])
	if second.Role != "peer" || second.Links[0].Peer == first.Links[0].Peer {
		t.Fatalf("spare parent not selected: %+v", second)
	}
	// A duplicate from the old generation cannot fail the replacement source.
	generation := h.rooms[r.ID].browser.generation
	fail(first.Generation)
	if h.rooms[r.ID].browser.generation != generation {
		t.Fatal("stale failure caused another replan")
	}
	fail(second.Generation)
	final := relayPlan(p[2])
	if final.Role != "direct" || len(p[2].browser.blockedParents) != 2 {
		t.Fatalf("did not stop failed source probing: %+v", final)
	}
	if h.browserReservedExcept(nil)*browserReservationMbps > 200 {
		t.Fatal("fallback bypassed budget")
	}
	if _, err := h.Action(r.ID, owner.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	if len(p[2].browser.blockedParents) != 0 || p[2].browser.failed {
		t.Fatal("failed parents leaked into the next sharing epoch")
	}
}

func TestBrowserRelayRetryCannotCreateUnbudgetedCentralStream(t *testing.T) {
	h, r, p := relayFixture(t, 24, 5)
	relayStart(t, h, r)
	first := relayPlan(p[2])
	if err := h.BrowserControl(p[2], BrowserCommand{Kind: "failed", Generation: first.Generation, Failure: "media_timeout"}); err != nil {
		t.Fatal(err)
	}
	second := relayPlan(p[2])
	if second.Role != "peer" {
		t.Fatalf("expected spare root: %+v", second)
	}
	if err := h.BrowserControl(p[2], BrowserCommand{Kind: "failed", Generation: second.Generation, Failure: "media_timeout"}); err != nil {
		t.Fatal(err)
	}
	if final := relayPlan(p[2]); final.Role != "waiting" {
		t.Fatalf("unbudgeted central fallback: %+v", final)
	}
	if h.browserReservedExcept(nil)*browserReservationMbps > 24 {
		t.Fatal("budget exceeded")
	}
}

func TestBrowserReportVisibilityAndRatesDoNotReuseStaleSamples(t *testing.T) {
	now := time.Unix(1000, 0)
	h, r, p := relayFixtureConfig(t, Config{BrowserRelayEnabled: true, BandwidthLimitMbps: 200, Now: func() time.Time { return now }}, 2)
	relayStart(t, h, r)
	generation := h.rooms[r.ID].browser.generation
	report := BrowserReport{Generation: generation, Visibility: "hidden", PeerBytes: 100, VerifiedFrames: 1, PlanFrames: 1}
	submit := func() error {
		return h.BrowserControl(p[2], BrowserCommand{Kind: "report", Generation: report.Generation, Report: &report})
	}
	if err := submit(); err != nil {
		t.Fatal(err)
	}
	if p[2].browser.rates != nil {
		t.Fatal("computed rate without two samples")
	}
	now = now.Add(2 * time.Second)
	report.PeerBytes += 250000
	report.CenterBytes = 50000
	report.SentBytes = 10000
	if err := submit(); err != nil {
		t.Fatal(err)
	}
	rates := p[2].browser.rates
	if rates == nil || rates.PeerBps != 1000000 || rates.CenterBps != 200000 || rates.SentBps != 40000 || rates.SampleMs != 2000 {
		t.Fatalf("wrong rates: %+v", rates)
	}
	if p[2].browser.report.Visibility != "hidden" {
		t.Fatal("lost background visibility")
	}
	report.Visibility = "forged-state"
	if err := submit(); err != ErrConflict {
		t.Fatalf("invalid visibility accepted: %v", err)
	}
	report.Visibility = "visible"
	now = now.Add(9 * time.Second)
	report.PeerBytes += 100000
	if err := submit(); err != nil {
		t.Fatal(err)
	}
	if p[2].browser.rates != nil {
		t.Fatal("stale rate sample reused")
	}
	h.browserReplan(h.rooms[r.ID])
	report.Generation = h.rooms[r.ID].browser.generation
	now = now.Add(2 * time.Second)
	if err := submit(); err != nil {
		t.Fatal(err)
	}
	if p[2].browser.rates != nil {
		t.Fatal("rate crossed a supply generation boundary")
	}
}

// This is a scheduling/admission test, not a 64-browser performance test.
func TestBrowserRelay64ViewerSchedulingHonorsGlobalBudget(t *testing.T) {
	for _, tc := range []struct {
		name                         string
		limit, roots, peers, waiting int
	}{{"ample", 200, 16, 48, 0}, {"constrained", 20, 1, 3, 60}} {
		t.Run(tc.name, func(t *testing.T) {
			h, r, people := relayFixture(t, tc.limit, 64)
			if r.BrowserRelayMaxViewers != 64 || len(people) != 65 {
				t.Fatal("default viewer capacity is not 64 plus the publisher")
			}
			if _, err := h.Join(r.ID, User{ID: "viewer-65"}, "over-capacity"); err != ErrCapacity {
				t.Fatalf("65th viewer admitted: %v", err)
			}
			active := relayStart(t, h, r)
			counts := map[string]int{}
			children := map[string]int{}
			for _, p := range people[1:] {
				plan := relayPlan(p)
				if plan == nil {
					t.Fatal("missing participant plan")
				}
				counts[plan.Role]++
				if len(plan.Links) > browserMaxFanout {
					t.Fatal("fanout exceeded")
				}
				if plan.Role == "peer" {
					if len(plan.Links) != 1 {
						t.Fatal("peer must have exactly one parent")
					}
					parent := plan.Links[0].Peer
					if !h.rooms[r.ID].browser.roots[parent] {
						t.Fatal("peer assigned to a nonroot")
					}
					children[parent]++
				}
			}
			if counts["root"] != tc.roots || counts["peer"] != tc.peers || counts["waiting"] != tc.waiting || counts["direct"] != 0 {
				t.Fatalf("unexpected topology: %+v", counts)
			}
			for _, count := range children {
				if count > browserMaxFanout {
					t.Fatal("parent oversubscribed")
				}
			}
			if reserved := h.browserReservedExcept(nil) * browserReservationMbps; reserved > tc.limit {
				t.Fatalf("reservation %d exceeded budget %d", reserved, tc.limit)
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
					t.Fatal("server sent media to a peer or waiting viewer")
				}
			}
		})
	}
}

func TestBrowserRelayStopsAfterThreeFailedSources(t *testing.T) {
	h, r, people := relayFixture(t, 200, 9)
	relayStart(t, h, r)
	// Leave three roots in place, with spare capacity on each alternative.
	h.RevokeSession(people[7].SessionID)
	h.RevokeSession(people[8].SessionID)
	child := people[2]
	sources := map[string]bool{}
	for attempt := 0; attempt < 3; attempt++ {
		plan := relayPlan(child)
		if plan == nil || plan.Role != "peer" || len(plan.Links) != 1 {
			t.Fatalf("attempt %d: %+v", attempt, plan)
		}
		source := plan.Links[0].Peer
		if sources[source] {
			t.Fatal("retried a source that had already failed")
		}
		sources[source] = true
		if err := h.BrowserControl(child, BrowserCommand{Kind: "failed", Generation: plan.Generation, Failure: "channel_closed"}); err != nil {
			t.Fatal(err)
		}
	}
	final := relayPlan(child)
	if final.Role != "direct" || len(child.browser.blockedParents) != 3 {
		t.Fatalf("unbounded retries: %+v", final)
	}
	generation := final.Generation
	if err := h.BrowserControl(child, BrowserCommand{Kind: "failed", Generation: generation, Failure: "channel_closed"}); err != nil {
		t.Fatal(err)
	}
	if h.rooms[r.ID].browser.generation != generation {
		t.Fatal("direct fallback restarted peer probing")
	}
}
