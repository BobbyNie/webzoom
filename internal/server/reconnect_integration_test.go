package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"webzoom/internal/auth"
	"webzoom/internal/meeting"
)

func TestFailedSocketUpgradeDoesNotConsumeReconnectGrant(t *testing.T) {
	ts, manager, hub := testApp(t)
	owner := meeting.User{ID: "owner"}
	viewer := meeting.User{ID: "viewer"}
	room, _ := hub.Create(owner)
	host, _ := hub.Join(room.ID, owner, "host-session")
	defer hub.Leave(host)
	session, _ := manager.NewSession(viewer, time.Now().Add(time.Hour))
	peer, _ := hub.Join(room.ID, viewer, session.ID)
	if _, err := hub.Action(room.ID, owner.ID, "annotation-grant", viewer.ID); err != nil {
		t.Fatal(err)
	}
	hub.Disconnect(peer)
	// An intermediary can reject/strip an upgrade before the real retry succeeds.
	response := do(t, ts, session, "GET", "/api/rooms/"+room.ID+"/ws?mediaAck=1", "", ts.URL)
	response.Body.Close()
	if response.StatusCode < 400 {
		t.Fatalf("ordinary GET upgraded: %d", response.StatusCode)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(ts.URL, "https")+"/api/rooms/"+room.ID+"/ws?mediaAck=1", &websocket.DialOptions{HTTPClient: ts.Client(), HTTPHeader: http.Header{"Origin": []string{ts.URL}, "Cookie": []string{auth.SessionCookie + "=" + session.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	snapshot, err := hub.Get(room.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(snapshot.Annotators, viewer.ID) {
		t.Fatal("failed upgrade consumed the recovery grant")
	}
}

func TestFailedUpgradesDoNotExtendRecoveryDeadline(t *testing.T) {
	ts := httptest.NewUnstartedServer(nil)
	manager := auth.NewStore("https://" + ts.Listener.Addr().String())
	initial := time.Now()
	var elapsed atomic.Int64
	hub := meeting.New(meeting.Config{Now: func() time.Time { return initial.Add(time.Duration(elapsed.Load()) * time.Second) }})
	ts.Config.Handler = New(Config{Auth: manager, Hub: hub})
	ts.StartTLS()
	defer ts.Close()
	owner, viewer := meeting.User{ID: "owner"}, meeting.User{ID: "viewer"}
	room, _ := hub.Create(owner)
	host, _ := hub.Join(room.ID, owner, "host-session")
	defer hub.Leave(host)
	session, _ := manager.NewSession(viewer, initial.Add(time.Hour))
	peer, _ := hub.Join(room.ID, viewer, session.ID)
	hub.Action(room.ID, owner.ID, "annotation-grant", viewer.ID)
	hub.Disconnect(peer)
	for _, seconds := range []int64{20, 29} {
		elapsed.Store(seconds)
		response := do(t, ts, session, "GET", "/api/rooms/"+room.ID+"/ws?mediaAck=1", "", ts.URL)
		response.Body.Close()
		if response.StatusCode < 400 {
			t.Fatal("ordinary GET unexpectedly upgraded")
		}
		deadline := time.Now().Add(time.Second)
		for {
			_, count, _ := hub.Counts()
			if count == 1 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("failed upgrade did not release peer")
			}
			time.Sleep(time.Millisecond)
		}
	}
	elapsed.Store(31)
	replacement, err := hub.Join(room.ID, viewer, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer hub.Leave(replacement)
	snapshot, _ := hub.Get(room.ID)
	if slices.Contains(snapshot.Annotators, viewer.ID) {
		t.Fatal("failed handshakes extended the original 30-second recovery deadline")
	}
}
