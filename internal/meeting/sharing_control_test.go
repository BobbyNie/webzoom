package meeting

import (
	"errors"
	"testing"
)

func TestCancelStartFencesBothRequestOrders(t *testing.T) {
	for _, applied := range []bool{false, true} {
		name := "before-start"
		if applied {
			name = "after-start"
		}
		t.Run(name, func(t *testing.T) {
			h := New(Config{})
			room, err := h.Create(User{ID: "owner"})
			if err != nil {
				t.Fatal(err)
			}
			peer, err := h.Join(room.ID, User{ID: "owner"}, "owner-session")
			if err != nil {
				t.Fatal(err)
			}
			defer h.Leave(peer)
			initial := room.Epoch
			if applied {
				if _, err = h.ActionAtEpoch(room.ID, "owner", "start", "", &initial); err != nil {
					t.Fatal(err)
				}
			}
			if err = h.SharingControl(peer, "cancel-start", &initial); err != nil {
				t.Fatal(err)
			}
			canceled, _ := h.Get(room.ID)
			if canceled.Active || canceled.Epoch == initial {
				t.Fatal("cancellation did not fence the old epoch")
			}
			if _, err = h.ActionAtEpoch(room.ID, "owner", "start", "", &initial); !errors.Is(err, ErrConflict) {
				t.Fatalf("late start accepted: %v", err)
			}
			if _, err = h.ActionAtEpoch(room.ID, "owner", "start", "", &canceled.Epoch); err != nil {
				t.Fatal(err)
			}
			current, _ := h.Get(room.ID)
			if err = h.SharingControl(peer, "cancel-start", &initial); !errors.Is(err, ErrConflict) {
				t.Fatalf("duplicate cancellation accepted: %v", err)
			}
			after, _ := h.Get(room.ID)
			if !after.Active || after.Epoch != current.Epoch {
				t.Fatal("old cancellation changed the new share")
			}
		})
	}
}

func TestSharingCleanupRejectsWrongOwnerOrTransport(t *testing.T) {
	h, room, owner, viewer := annotationFixture(t)
	initial := room.Epoch - 1
	if err := h.SharingControl(viewer, "cancel-start", &initial); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer cleanup accepted: %v", err)
	}
	if err := h.SharingControl(owner, "cancel-start", &room.Epoch); !errors.Is(err, ErrConflict) {
		t.Fatalf("active original epoch accepted as pending start: %v", err)
	}
	if err := h.SharingControl(owner, "cancel-start", nil); !errors.Is(err, ErrForbidden) {
		t.Fatal("missing epoch accepted")
	}
	h.Leave(owner)
	replacement, err := h.Join(room.ID, owner.User, owner.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Leave(replacement)
	current, err := h.Action(room.ID, "owner", "start", "")
	if err != nil {
		t.Fatal(err)
	}
	if err = h.SharingControl(owner, "stop", &current.Epoch); !errors.Is(err, ErrForbidden) {
		t.Fatalf("removed transport accepted: %v", err)
	}
	if err = h.SharingControl(replacement, "transfer", &current.Epoch); !errors.Is(err, ErrForbidden) {
		t.Fatal("unrelated action accepted")
	}
	snapshot, _ := h.Get(room.ID)
	if !snapshot.Active || snapshot.Epoch != current.Epoch {
		t.Fatal("unauthorized cleanup changed share")
	}
	if err = h.SharingControl(replacement, "stop", &current.Epoch); err != nil {
		t.Fatal(err)
	}
	snapshot, _ = h.Get(room.ID)
	if snapshot.Active {
		t.Fatal("valid stop failed")
	}
}

func TestCancelStartBroadcastsStoppedRelayAndAnnotations(t *testing.T) {
	h, r, people := relayFixture(t, 200, 3)
	initial := r.Epoch
	active := relayStart(t, h, r)
	if err := h.Annotate(people[0], drawFor(active, 0)); err != nil {
		t.Fatal(err)
	}
	for _, p := range people {
		for len(p.Events) > 0 {
			<-p.Events
		}
	}
	if err := h.SharingControl(people[0], "cancel-start", &initial); err != nil {
		t.Fatal(err)
	}
	stopped, _ := h.Get(r.ID)
	for _, p := range people {
		var plan *BrowserPlan
		var annotations *AnnotationState
		for len(p.Events) > 0 {
			e := <-p.Events
			if e.BrowserPlan != nil {
				plan = e.BrowserPlan
			}
			if e.Annotations != nil {
				annotations = e.Annotations
			}
		}
		if plan == nil || plan.Active || plan.Epoch != stopped.Epoch || len(plan.Links) != 0 || annotations == nil || annotations.Epoch != stopped.Epoch || len(annotations.Strokes) != 0 {
			t.Fatalf("cancellation left stale client state for %s: plan=%+v annotations=%+v stopped=%+v", p.User.ID, plan, annotations, stopped)
		}
	}
}
