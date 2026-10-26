package meeting

import (
	"slices"
	"testing"
	"time"
)

func TestAnnotationReconnectGrantBoundaries(t *testing.T) {
	for _, mode := range []string{"transient", "new-session", "expired-grace", "revoked", "logout", "stop", "transfer", "explicit-leave", "offline-leave", "room-ended"} {
		t.Run(mode, func(t *testing.T) {
			h, s, _, guest := annotationFixture(t)
			now := time.Now()
			h.cfg.Now = func() time.Time { return now }
			if _, err := h.Action(s.ID, "owner", "annotation-grant", "guest"); err != nil {
				t.Fatal(err)
			}
			if mode == "explicit-leave" {
				if _, err := h.Action(s.ID, "guest", "leave", ""); err != nil {
					t.Fatal(err)
				}
				h.Disconnect(guest)
			} else {
				h.Disconnect(guest)
			}
			if err := h.Annotate(guest, AnnotationCommand{Kind: "pointer", Epoch: s.Epoch, Points: []Point{{X: .1, Y: .1}}}); err == nil {
				t.Fatal("disconnected peer remained authorized")
			}
			session := "guest-session"
			switch mode {
			case "new-session":
				session = "other-session"
			case "expired-grace":
				now = now.Add(annotationReconnectGrace)
			case "revoked":
				if _, err := h.Action(s.ID, "owner", "annotation-revoke", "guest"); err != nil {
					t.Fatal(err)
				}
			case "offline-leave":
				for range 2 { // Leaving is idempotent even while disconnected.
					if _, err := h.Action(s.ID, "guest", "leave", ""); err != nil {
						t.Fatal(err)
					}
				}
			case "logout":
				h.RevokeSession(session)
			case "stop":
				h.Action(s.ID, "owner", "stop", "")
			case "transfer":
				h.Action(s.ID, "owner", "transfer", "owner")
			case "room-ended":
				h.Action(s.ID, "owner", "end", "")
			}
			peer, err := h.Join(s.ID, guest.User, session)
			if mode == "room-ended" {
				if err == nil {
					t.Fatal("ended room rejoined")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := h.Get(s.ID)
			if err != nil {
				t.Fatal(err)
			}
			granted := slices.Contains(snapshot.Annotators, guest.User.ID)
			if granted != (mode == "transient") {
				t.Fatalf("grant restored=%v", granted)
			}
			h.Disconnect(guest) // A late cleanup from the old connection cannot remove its replacement.
			if current := h.rooms[s.ID].peers[guest.User.ID]; current != peer {
				t.Fatal("stale cleanup removed new peer")
			}
		})
	}
}

func TestReconnectNeverRestoresPendingRequest(t *testing.T) {
	h, s, _, guest := annotationFixture(t)
	h.Action(s.ID, "guest", "annotation-request", "")
	h.Disconnect(guest)
	if _, err := h.Join(s.ID, guest.User, guest.SessionID); err != nil {
		t.Fatal(err)
	}
	snapshot, _ := h.Get(s.ID)
	if len(snapshot.AnnotationRequests) != 0 || len(snapshot.Annotators) != 0 {
		t.Fatal("pending request became authorization")
	}
}

func TestEstablishedReconnectStartsFreshGrace(t *testing.T) {
	h, s, _, guest := annotationFixture(t)
	now := time.Now()
	h.cfg.Now = func() time.Time { return now }
	if _, err := h.Action(s.ID, "owner", "annotation-grant", "guest"); err != nil {
		t.Fatal(err)
	}
	h.Disconnect(guest)
	now = now.Add(25 * time.Second)
	reconnected, err := h.Join(s.ID, guest.User, guest.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	// A successfully established transport later failing is a new outage, not
	// another failed upgrade in the original outage's recovery window.
	h.Disconnect(reconnected)
	now = now.Add(20 * time.Second)
	last, err := h.Join(s.ID, guest.User, guest.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Leave(last)
	snapshot, err := h.Get(s.ID)
	if err != nil || !slices.Contains(snapshot.Annotators, guest.User.ID) {
		t.Fatalf("established connection did not earn a fresh recovery window: %v", err)
	}
}
