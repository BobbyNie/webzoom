package meeting

import (
	"sync"
	"testing"
)

func TestAdminEndRoomsClosesOnlySelectedRooms(t *testing.T) {
	h, room, pub, viewerPeer := setup(t)
	untouched, _ := h.Create(User{ID: "other-owner"})
	s, _ := h.Action(room.ID, owner.ID, "start", "")
	if err := h.Publish(pub, frame(s.Epoch, 1, true)); err != nil {
		t.Fatal(err)
	}
	result := h.EndRooms([]string{room.ID, "missing", room.ID})
	if len(result) != 2 || result[0].ID != room.ID || result[0].Status != "ended" || result[1].Status != "not_found" {
		t.Fatalf("wrong result: %+v", result)
	}
	for _, p := range []*Peer{pub, viewerPeer} {
		select {
		case <-p.Done:
		default:
			t.Fatal("participant remains connected")
		}
		if p.Media.Len() != 0 {
			t.Fatal("ended media queue not cleared")
		}
		if p.Reason != "meeting ended by administrator" {
			t.Fatal("missing admin end reason", p.Reason)
		}
	}
	if _, err := h.Get(room.ID); err != ErrNotFound {
		t.Fatal("ended link remains usable", err)
	}
	if _, err := h.Join(room.ID, owner, "retry"); err != ErrNotFound {
		t.Fatal("ended meeting can reconnect", err)
	}
	if err := h.Publish(pub, frame(s.Epoch, 2, false)); err != ErrNotFound {
		t.Fatal("old publisher can publish", err)
	}
	if _, err := h.Get(untouched.ID); err != nil {
		t.Fatal("unselected meeting ended", err)
	}
	if again := h.EndRooms([]string{room.ID}); again[0].Status != "not_found" {
		t.Fatal("retry not safe", again)
	}
}

func TestConcurrentAdminAndOwnerEndRooms(t *testing.T) {
	for iteration := 0; iteration < 50; iteration++ {
		h := New(Config{})
		room, _ := h.Create(User{ID: "owner"})
		owner, _ := h.Join(room.ID, User{ID: "owner"}, "owner-session")
		_, _ = h.Join(room.ID, User{ID: "viewer"}, "viewer-session")
		start := make(chan struct{})
		results := make(chan []EndResult, 2)
		var wg sync.WaitGroup
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func() { defer wg.Done(); <-start; results <- h.EndRooms([]string{room.ID}) }()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, _ = h.Action(room.ID, "owner", "transfer", "viewer")
			_, _ = h.Action(room.ID, "owner", "end", "")
		}()
		close(start)
		wg.Wait()
		close(results)
		ended := 0
		for batch := range results {
			if batch[0].Status == "ended" {
				ended++
			}
		}
		if ended > 1 {
			t.Fatal("room ended twice")
		}
		if _, err := h.Get(room.ID); err != ErrNotFound {
			t.Fatal(err)
		}
		select {
		case <-owner.Done:
		default:
			t.Fatal("owner connection not closed")
		}
	}
}

func TestConcurrentAdministratorsEndExactlyOnce(t *testing.T) {
	h := New(Config{})
	room, _ := h.Create(User{ID: "owner"})
	results := make(chan []EndResult, 2)
	for i := 0; i < 2; i++ {
		go func() { results <- h.EndRooms([]string{room.ID}) }()
	}
	ended := 0
	for i := 0; i < 2; i++ {
		if (<-results)[0].Status == "ended" {
			ended++
		}
	}
	if ended != 1 {
		t.Fatalf("ended=%d", ended)
	}
}
