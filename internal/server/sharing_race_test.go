package server

import (
	"fmt"
	"testing"
	"time"
	"webzoom/internal/meeting"
)

func TestStaleSharingActionCannotChangeReplacementEpoch(t *testing.T) {
	for _, action := range []string{"start", "stop"} {
		t.Run(action, func(t *testing.T) {
			ts, manager, hub := testApp(t)
			owner := meeting.User{ID: "owner"}
			session, _ := manager.NewSession(owner, time.Now().Add(time.Hour))
			room, _ := hub.Create(owner)
			peer, _ := hub.Join(room.ID, owner, session.ID)
			defer hub.Leave(peer)
			old, _ := hub.Action(room.ID, owner.ID, "start", "")
			hub.Action(room.ID, owner.ID, "stop", "")
			current, _ := hub.Action(room.ID, owner.ID, "start", "")
			response := do(t, ts, session, "POST", "/api/rooms/"+room.ID+"/actions", fmt.Sprintf(`{"action":%q,"epoch":%d}`, action, old.Epoch), ts.URL)
			response.Body.Close()
			if response.StatusCode != 409 {
				t.Fatalf("stale action status=%d, want 409", response.StatusCode)
			}
			snapshot, _ := hub.Get(room.ID)
			if !snapshot.Active || snapshot.Epoch != current.Epoch {
				t.Fatal("old action changed the newer share")
			}
			response = do(t, ts, session, "POST", "/api/rooms/"+room.ID+"/actions", fmt.Sprintf(`{"action":"stop","epoch":%d}`, current.Epoch), ts.URL)
			response.Body.Close()
			if response.StatusCode != 200 {
				t.Fatalf("current action status=%d", response.StatusCode)
			}
		})
	}
}
