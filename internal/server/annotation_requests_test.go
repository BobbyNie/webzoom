package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
	"webzoom/internal/meeting"
)

func TestAnnotationRequestAPIAuthenticationAndRate(t *testing.T) {
	ts, auth, hub := testApp(t)
	owner, _ := auth.NewSession(meeting.User{ID: "owner", Name: "Owner"}, time.Now().Add(time.Hour))
	guest, _ := auth.NewSession(meeting.User{ID: "guest", Name: "Guest"}, time.Now().Add(time.Hour))
	room, _ := hub.Create(owner.User)
	hub.Join(room.ID, owner.User, owner.ID)
	hub.Join(room.ID, guest.User, guest.ID)
	path := "/api/rooms/" + room.ID + "/actions"
	post := func(action string, status int) *http.Response {
		t.Helper()
		res := do(t, ts, guest, "POST", path, `{"action":"`+action+`","target":""}`, ts.URL)
		t.Cleanup(func() { res.Body.Close() })
		if res.StatusCode != status {
			t.Fatalf("%s: got %d, want %d", action, res.StatusCode, status)
		}
		return res
	}
	res := do(t, ts, nil, "POST", path, `{"action":"annotation-request"}`, ts.URL)
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal(res.StatusCode)
	}
	res = do(t, ts, guest, "POST", path, `{"action":"annotation-request"}`, "https://evil.example")
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal(res.StatusCode)
	}
	post("annotation-approve-all", 403)
	for range 5 {
		res = post("annotation-request", 200)
		var state meeting.Snapshot
		if err := json.NewDecoder(res.Body).Decode(&state); err != nil || len(state.AnnotationRequests) != 1 || len(state.Annotators) != 0 {
			t.Fatal(state, err)
		}
		post("annotation-cancel", 200)
	}
	res = post("annotation-request", 429)
	if res.Header.Get("X-WebZoom-Error") != "annotation_request_rate" || res.Header.Get("Retry-After") != "10" {
		t.Fatal(res.Header)
	}
}
