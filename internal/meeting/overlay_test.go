package meeting

import (
	"errors"
	"testing"
)

func TestOverlayReadOnlyScopeAndLifecycle(t *testing.T) {
	for _, action := range []string{"stop", "transfer", "end", "leave", "revoke"} {
		t.Run(action, func(t *testing.T) {
			h, s, owner, _ := annotationFixture(t)
			for _, args := range [][3]string{{"guest", "guest-session", "guest"}, {"owner", "wrong", "wrong-session"}} {
				if _, err := h.SubscribeOverlay(s.ID, args[0], args[1], s.Epoch); !errors.Is(err, ErrForbidden) {
					t.Fatal(args, err)
				}
			}
			if _, err := h.SubscribeOverlay(s.ID, "owner", "owner-session", s.Epoch-1); !errors.Is(err, ErrConflict) {
				t.Fatal(err)
			}
			o, err := h.SubscribeOverlay(s.ID, "owner", "owner-session", s.Epoch)
			if err != nil {
				t.Fatal(err)
			}
			if ev := <-o.Events; ev.Type != "annotations" || ev.Annotations.Epoch != s.Epoch {
				t.Fatal(ev)
			}
			if err := h.Annotate(owner, drawFor(s, 0)); err != nil {
				t.Fatal(err)
			}
			if ev := <-o.Events; ev.Annotation == nil || ev.Annotation.Kind != "draw" {
				t.Fatal(ev)
			}
			snap, _ := h.Get(s.ID)
			if len(snap.Participants) != 2 {
				t.Fatal("helper became participant")
			}
			switch action {
			case "leave":
				h.Leave(owner)
			case "revoke":
				h.RevokeSession("owner-session")
			default:
				_, err = h.Action(s.ID, "owner", action, "guest")
				if err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-o.Done:
			default:
				t.Fatal("overlay survived lifecycle boundary")
			}
		})
	}
}
func TestOverlaySlowReaderCannotBreakMeeting(t *testing.T) {
	h, s, owner, _ := annotationFixture(t)
	o, _ := h.SubscribeOverlay(s.ID, "owner", "owner-session", s.Epoch)
	h.mu.Lock()
	for i := 0; i < 70; i++ {
		emitOverlay(h.rooms[s.ID], Event{Type: "annotation", Annotation: &AnnotationEvent{Kind: "draw"}})
	}
	h.mu.Unlock()
	select {
	case <-o.Done:
	default:
		t.Fatal("unbounded overlay queue")
	}
	select {
	case <-owner.Done:
		t.Fatal("slow helper disconnected publisher")
	default:
	}
	if !h.OverlayAlive(o) {
		return
	}
	t.Fatal("closed helper still alive")
}
func TestOverlayReplacementAndSessionScopedStop(t *testing.T) {
	h, s, _, _ := annotationFixture(t)
	old, _ := h.SubscribeOverlay(s.ID, "owner", "owner-session", s.Epoch)
	current, _ := h.SubscribeOverlay(s.ID, "owner", "owner-session", s.Epoch)
	select {
	case <-old.Done:
	default:
		t.Fatal("old helper not closed")
	}
	h.UnsubscribeOverlay(old)
	h.StopOverlay(s.ID, "owner", "different-session")
	if !h.OverlayAlive(current) {
		t.Fatal("wrong session/old cleanup closed new helper")
	}
	h.StopOverlay(s.ID, "owner", "owner-session")
	if h.OverlayAlive(current) {
		t.Fatal("explicit disconnect failed")
	}
}
