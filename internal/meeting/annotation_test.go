package meeting

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"testing"
	"time"
)

func annotationFixture(t *testing.T) (*Hub, Snapshot, *Peer, *Peer) {
	t.Helper()
	h := New(Config{})
	s, _ := h.Create(User{ID: "owner", Name: "Owner"})
	owner, _ := h.Join(s.ID, User{ID: "owner", Name: "Owner"}, "owner-session")
	guest, _ := h.Join(s.ID, User{ID: "guest", Name: "Guest"}, "guest-session")
	s, err := h.Action(s.ID, "owner", "start", "")
	if err != nil {
		t.Fatal(err)
	}
	return h, s, owner, guest
}
func drawFor(s Snapshot, generation uint32) AnnotationCommand {
	return AnnotationCommand{Kind: "draw", Epoch: s.Epoch, Generation: generation, StrokeID: "stroke-1", Color: "#e53935", Points: []Point{{X: .1, Y: .2}, {X: .3, Y: .4}}}
}
func TestAnnotationPermissionIsSeparateFromPublishing(t *testing.T) {
	h, s, owner, guest := annotationFixture(t)
	c := drawFor(s, 0)
	if err := h.Annotate(guest, c); !errors.Is(err, ErrForbidden) {
		t.Fatal("ungranted participant accepted", err)
	}
	if _, err := h.Action(s.ID, "guest", "annotation-grant", "guest"); !errors.Is(err, ErrForbidden) {
		t.Fatal("guest granted permission", err)
	}
	granted, err := h.Action(s.ID, "owner", "annotation-grant", "guest")
	if err != nil || granted.PublisherID != "owner" || len(granted.Annotators) != 1 {
		t.Fatal(granted, err)
	}
	if err = h.Annotate(guest, c); err != nil {
		t.Fatal(err)
	}
	if _, err = h.Action(s.ID, "owner", "annotation-revoke", "guest"); err != nil {
		t.Fatal(err)
	}
	if err = h.Annotate(guest, AnnotationCommand{Kind: "pointer", Epoch: s.Epoch, Points: []Point{{X: .2, Y: .3}}}); !errors.Is(err, ErrForbidden) {
		t.Fatal("revoked pointer accepted", err)
	}
	if err = h.Annotate(owner, AnnotationCommand{Kind: "clear-all", Epoch: s.Epoch}); err != nil {
		t.Fatal(err)
	}
}
func TestAnnotationReplayLateJoinClearAndEpoch(t *testing.T) {
	h, s, owner, guest := annotationFixture(t)
	h.Action(s.ID, "owner", "annotation-grant", "guest")
	c := drawFor(s, 0)
	if err := h.Annotate(guest, c); err != nil {
		t.Fatal(err)
	}
	if err := h.Annotate(guest, c); !errors.Is(err, ErrConflict) {
		t.Fatal("duplicate segment accepted", err)
	}
	late, _ := h.Join(s.ID, User{ID: "late", Name: "Late"}, "late")
	found := false
	for len(late.Events) > 0 {
		e := <-late.Events
		if e.Annotations != nil {
			found = true
			if len(e.Annotations.Strokes) != 1 || e.Annotations.Strokes[0].User.ID != "guest" {
				t.Fatal(e)
			}
		}
	}
	if !found {
		t.Fatal("late join missing authoritative annotations")
	}
	if err := h.Annotate(guest, AnnotationCommand{Kind: "clear-all", Epoch: s.Epoch}); !errors.Is(err, ErrForbidden) {
		t.Fatal("guest cleared everyone", err)
	}
	if err := h.Annotate(owner, AnnotationCommand{Kind: "clear-all", Epoch: s.Epoch}); err != nil {
		t.Fatal(err)
	}
	c.Segment = 1
	if err := h.Annotate(guest, c); !errors.Is(err, ErrConflict) {
		t.Fatal("pre-clear segment accepted", err)
	}
	next, _ := h.Action(s.ID, "owner", "stop", "")
	if err := h.Annotate(owner, drawFor(next, 0)); !errors.Is(err, ErrConflict) {
		t.Fatal("drawing with no active share", err)
	}
	next, _ = h.Action(s.ID, "owner", "start", "")
	if err := h.Annotate(owner, drawFor(s, 0)); !errors.Is(err, ErrConflict) {
		t.Fatal("old epoch accepted", err)
	}
	_ = next
}
func TestAnnotationValidatesBoundsAndConnection(t *testing.T) {
	h, s, owner, guest := annotationFixture(t)
	for _, point := range []Point{{X: -.1, Y: .2}, {X: 1.1, Y: .2}, {X: math.NaN(), Y: .2}, {X: .2, Y: math.Inf(1)}} {
		c := drawFor(s, 0)
		c.Points = []Point{point}
		if err := h.Annotate(owner, c); err == nil {
			t.Fatal("invalid point accepted", point)
		}
	}
	c := drawFor(s, 0)
	c.Color = "url(evil)"
	if err := h.Annotate(owner, c); err == nil {
		t.Fatal("invalid color accepted")
	}
	c = drawFor(s, 0)
	c.Points = make([]Point, 33)
	if err := h.Annotate(owner, c); err == nil {
		t.Fatal("unbounded command accepted")
	}
	h.Action(s.ID, "owner", "annotation-grant", "guest")
	h.Leave(guest)
	if err := h.Annotate(guest, drawFor(s, 0)); !errors.Is(err, ErrForbidden) {
		t.Fatal("disconnected sender accepted", err)
	}
	state, _ := h.Get(s.ID)
	if len(state.Annotators) != 0 {
		t.Fatal("permission survived departure")
	}
}

func drainAnnotationEvents(peers ...*Peer) {
	for _, p := range peers {
		for len(p.Events) > 0 {
			<-p.Events
		}
	}
}
func TestAnnotationClearOwnAndBoundedStorage(t *testing.T) {
	h, s, owner, guest := annotationFixture(t)
	h.Action(s.ID, "owner", "annotation-grant", "guest")
	if err := h.Annotate(owner, drawFor(s, 0)); err != nil {
		t.Fatal(err)
	}
	if err := h.Annotate(guest, drawFor(s, 0)); err != nil {
		t.Fatal(err)
	}
	if err := h.Annotate(guest, AnnotationCommand{Kind: "clear-own", Epoch: s.Epoch}); err != nil {
		t.Fatal(err)
	}
	state := annotationSnapshot(h.rooms[s.ID])
	if len(state.Strokes) != 1 || state.Strokes[0].User.ID != "owner" || state.Generation != 1 {
		t.Fatal(state)
	}
	// Snapshots are independent from later room mutation.
	state.Strokes[0].Points[0].X = .99
	if h.rooms[s.ID].annotations.strokes[0].Points[0].X == .99 {
		t.Fatal("snapshot aliases persistent points")
	}
	h.Annotate(owner, AnnotationCommand{Kind: "clear-all", Epoch: s.Epoch, Generation: 1})
	now := time.Now()
	h.cfg.Now = func() time.Time { return now }
	for i := 0; i < maxAnnotationStrokes; i++ {
		now = now.Add(time.Second)
		drainAnnotationEvents(owner, guest)
		c := drawFor(s, 2)
		c.StrokeID = fmt.Sprintf("s-%d", i)
		if err := h.Annotate(owner, c); err != nil {
			t.Fatal(i, err)
		}
	}
	now = now.Add(time.Second)
	drainAnnotationEvents(owner, guest)
	c := drawFor(s, 2)
	c.StrokeID = "too-many"
	if err := h.Annotate(owner, c); !errors.Is(err, ErrCapacity) {
		t.Fatal("stroke storage not bounded", err)
	}
}
func TestAnnotationPointerBudgetNeverClosesSlowViewers(t *testing.T) {
	h, s, owner, guest := annotationFixture(t)
	now := time.Now()
	h.cfg.Now = func() time.Time { return now }
	for i := 0; i < 100; i++ {
		err := h.Annotate(owner, AnnotationCommand{Kind: "pointer", Epoch: s.Epoch, Points: []Point{{X: .3, Y: .4}}})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []*Peer{owner, guest} {
		select {
		case <-p.Done:
			t.Fatal("pointer overflow disconnected a viewer")
		default:
		}
	}
	if len(guest.Events) > 8 {
		t.Fatal("pointer queue not bounded")
	}
}

func TestAnnotationWireIncludesInitialSegment(t *testing.T) {
	data, err := json.Marshal(AnnotationEvent{Kind: "draw", Segment: 0})
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	json.Unmarshal(data, &wire)
	if segment, ok := wire["segment"]; !ok || segment != float64(0) {
		t.Fatal("first draw segment missing from wire", string(data))
	}
}
