package server

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"strings"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/meeting"
)

func TestAnnotationWebSocketAuthorizationAndRevocation(t *testing.T) {
	ts, a, h := testApp(t)
	owner := meeting.User{ID: "annotation-owner", Name: "Owner"}
	guest := meeting.User{ID: "annotation-guest", Name: "Guest"}
	os, _ := a.NewSession(owner, time.Now().Add(time.Hour))
	gs, _ := a.NewSession(guest, time.Now().Add(time.Hour))
	room, _ := h.Create(owner)
	h.Join(room.ID, owner, os.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(ts.URL, "https")+"/api/rooms/"+room.ID+"/ws", &websocket.DialOptions{HTTPClient: ts.Client(), HTTPHeader: http.Header{"Origin": []string{ts.URL}, "Cookie": []string{auth.SessionCookie + "=" + gs.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	room, _ = h.Action(room.ID, owner.ID, "start", "")
	command := map[string]any{"type": "annotation", "annotation": map[string]any{"kind": "draw", "epoch": room.Epoch, "generation": 0, "strokeId": "wire-stroke", "segment": 0, "color": "#e53935", "points": []meeting.Point{{X: .2, Y: .3}}, "user": owner}}
	send := func(v any) {
		t.Helper()
		data, _ := json.Marshal(v)
		if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
			t.Fatal(err)
		}
	}
	read := func(kind string) meeting.Event {
		t.Helper()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var e meeting.Event
			if json.Unmarshal(data, &e) == nil && e.Type == kind {
				return e
			}
		}
	}
	send(command)
	read("annotation-error")
	path := "/api/rooms/" + room.ID + "/actions"
	body := `{"action":"annotation-grant","target":"annotation-guest"}`
	response := do(t, ts, gs, "POST", path, body, ts.URL)
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("participant can grant", response.StatusCode)
	}
	response = do(t, ts, os, "POST", path, body, "https://evil.example")
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("cross-origin grant accepted")
	}
	response = do(t, ts, os, "POST", path, body, ts.URL)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	send(command)
	event := read("annotation")
	if event.Annotation == nil || event.Annotation.User.ID != guest.ID {
		t.Fatal("sender can spoof drawing author", event)
	}
	response = do(t, ts, os, "POST", path, `{"action":"annotation-revoke","target":"annotation-guest"}`, ts.URL)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal(response.StatusCode)
	}
	send(command)
	read("annotation-error")
	// Annotation denial must not kick the participant out of the media meeting.
	send(map[string]any{"type": "clock", "clientTime": 1})
	read("clock")
}
