package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/meeting"
)

type overlayFixture struct {
	ts              *httptest.Server
	a               *auth.Manager
	h               *meeting.Hub
	s, guest, other *auth.Session
	room            meeting.Snapshot
	owner           *meeting.Peer
}

func newOverlayFixture(t *testing.T) *overlayFixture {
	t.Helper()
	ts, a, h := testApp(t)
	owner := meeting.User{ID: "overlay-owner", Name: "Owner"}
	guest := meeting.User{ID: "overlay-guest", Name: "Guest"}
	s, _ := a.NewSession(owner, time.Now().Add(time.Hour))
	gs, _ := a.NewSession(guest, time.Now().Add(time.Hour))
	other, _ := a.NewSession(owner, time.Now().Add(time.Hour))
	room, _ := h.Create(owner)
	peer, _ := h.Join(room.ID, owner, s.ID)
	_, _ = h.Join(room.ID, guest, gs.ID)
	room, _ = h.Action(room.ID, owner.ID, "start", "")
	return &overlayFixture{ts, a, h, s, gs, other, room, peer}
}
func (f *overlayFixture) issue(t *testing.T) string {
	t.Helper()
	res := do(t, f.ts, f.s, "POST", "/api/rooms/"+f.room.ID+"/overlay", fmt.Sprintf(`{"epoch":%d,"surface":"monitor","width":1920,"height":1080}`, f.room.Epoch), f.ts.URL)
	defer res.Body.Close()
	if res.StatusCode != 200 || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("pairing response", res.StatusCode)
	}
	var body struct {
		Pairing string `json:"pairing"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(body.Pairing, "#webzoom-overlay=")
	if len(parts) != 2 || len(parts[1]) != 43 {
		t.Fatal("invalid pairing format")
	}
	return parts[1]
}
func (f *overlayFixture) dial(t *testing.T, code, origin string) (*websocket.Conn, int, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	headers := http.Header{"Authorization": []string{"Bearer " + code}}
	if origin != "" {
		headers.Set("Origin", origin)
	}
	c, res, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(f.ts.URL, "https")+"/api/overlay/ws", &websocket.DialOptions{HTTPClient: f.ts.Client(), HTTPHeader: headers})
	status := 0
	if res != nil {
		status = res.StatusCode
	}
	if c != nil {
		t.Cleanup(func() { c.CloseNow() })
	}
	return c, status, err
}
func overlayRead(t *testing.T, c *websocket.Conn) map[string]json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	typ, data, err := c.Read(ctx)
	if err != nil || typ != websocket.MessageText {
		t.Fatal("read overlay", typ, err)
	}
	var event map[string]json.RawMessage
	if json.Unmarshal(data, &event) != nil {
		t.Fatal("invalid message")
	}
	return event
}
func overlayClosed(t *testing.T, c *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		_, _, err := c.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				t.Fatal("helper did not disconnect promptly")
			}
			return
		}
	}
}
func TestOverlayPairingAuthorization(t *testing.T) {
	f := newOverlayFixture(t)
	path := "/api/rooms/" + f.room.ID + "/overlay"
	valid := fmt.Sprintf(`{"epoch":%d,"surface":"monitor","width":1920,"height":1080}`, f.room.Epoch)
	for _, c := range []struct {
		name         string
		s            *auth.Session
		body, origin string
		want         int
	}{
		{"anonymous", nil, valid, f.ts.URL, 401}, {"guest", f.guest, valid, f.ts.URL, 403}, {"same user different session", f.other, valid, f.ts.URL, 403},
		{"cross origin", f.s, valid, "https://evil.example", 403}, {"tab capture", f.s, strings.Replace(valid, "monitor", "browser", 1), f.ts.URL, 400},
		{"wrong epoch", f.s, strings.Replace(valid, fmt.Sprintf(`"epoch":%d`, f.room.Epoch), `"epoch":0`, 1), f.ts.URL, 409},
		{"extra fields", f.s, strings.TrimSuffix(valid, "}") + `,"admin":true}`, f.ts.URL, 400},
	} {
		t.Run(c.name, func(t *testing.T) {
			res := do(t, f.ts, c.s, "POST", path, c.body, c.origin)
			res.Body.Close()
			if res.StatusCode != c.want {
				t.Fatalf("status %d, want %d", res.StatusCode, c.want)
			}
		})
	}
}
func TestOverlaySingleUseReadOnlyAndSnapshot(t *testing.T) {
	f := newOverlayFixture(t)
	code := f.issue(t)
	if _, status, err := f.dial(t, code, f.ts.URL); err == nil || status != 401 {
		t.Fatal("browser connection accepted", status)
	}
	// Rejected browser-origin requests do not consume the code.
	c, status, err := f.dial(t, code, "")
	if err != nil || status != 101 {
		t.Fatal("native connection", status, err)
	}
	if string(overlayRead(t, c)["type"]) != `"overlay-ready"` {
		t.Fatal("missing handshake")
	}
	if string(overlayRead(t, c)["type"]) != `"annotations"` {
		t.Fatal("missing initial snapshot")
	}
	if _, status, err := f.dial(t, code, ""); err == nil || status != 401 {
		t.Fatal("reused code accepted", status)
	}
	err = f.h.Annotate(f.owner, meeting.AnnotationCommand{Kind: "draw", Epoch: f.room.Epoch, StrokeID: "test", Color: "#e53935", Points: []meeting.Point{{X: .2, Y: .3}}})
	if err != nil {
		t.Fatal(err)
	}
	if string(overlayRead(t, c)["type"]) != `"annotation"` {
		t.Fatal("no live annotation")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"annotation"}`))
	overlayClosed(t, c)
	snapshot, _ := f.h.Get(f.room.ID)
	if len(snapshot.Participants) != 2 {
		t.Fatal("helper changed participants")
	}
}
func TestOverlayTicketReplacementAndStop(t *testing.T) {
	f := newOverlayFixture(t)
	old := f.issue(t)
	code := f.issue(t)
	if _, status, err := f.dial(t, old, ""); err == nil || status != 401 {
		t.Fatal("old pairing survived replacement")
	}
	c, _, err := f.dial(t, code, "")
	if err != nil {
		t.Fatal(err)
	}
	overlayRead(t, c)
	overlayRead(t, c)
	pending := f.issue(t)
	res := do(t, f.ts, f.s, "DELETE", "/api/rooms/"+f.room.ID+"/overlay", "", f.ts.URL)
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatal(res.StatusCode)
	}
	overlayClosed(t, c)
	if _, status, err := f.dial(t, pending, ""); err == nil || status != 401 {
		t.Fatal("revoked pairing accepted")
	}
}
func TestOverlayStopsOnSessionOrShareEnd(t *testing.T) {
	for _, boundary := range []string{"session", "stop", "transfer", "end"} {
		t.Run(boundary, func(t *testing.T) {
			f := newOverlayFixture(t)
			code := f.issue(t)
			c, _, err := f.dial(t, code, "")
			if err != nil {
				t.Fatal(err)
			}
			overlayRead(t, c)
			overlayRead(t, c)
			if boundary == "session" {
				f.a.Delete(f.s.ID)
			} else {
				_, err = f.h.Action(f.room.ID, f.s.User.ID, boundary, f.guest.User.ID)
				if err != nil {
					t.Fatal(err)
				}
			}
			overlayClosed(t, c)
		})
	}
}
func TestOverlayOldEpochTicketCannotReconnect(t *testing.T) {
	f := newOverlayFixture(t)
	code := f.issue(t)
	_, _ = f.h.Action(f.room.ID, f.s.User.ID, "stop", "")
	_, _ = f.h.Action(f.room.ID, f.s.User.ID, "start", "")
	if _, status, err := f.dial(t, code, ""); err == nil || status != 409 {
		t.Fatal("old sharing epoch accepted", status)
	}
}
func TestOverlayExpiredTicket(t *testing.T) {
	// Inject a past ticket into a standalone handler; no sleeps and no weak clock.
	f := newOverlayFixture(t)
	code := strings.Repeat("a", 43)
	app := &app{Config: Config{Auth: f.a, Hub: f.h}, overlay: overlayTickets{values: map[[32]byte]overlayTicket{}}}
	app.overlay.values[sha256.Sum256([]byte(code))] = overlayTicket{room: f.room.ID, user: f.s.User.ID, session: f.s.ID, epoch: f.room.Epoch, expires: time.Now().Add(-time.Second)}
	req := httptest.NewRequest("GET", "https://meeting.example/api/overlay/ws", nil)
	req.Header.Set("Authorization", "Bearer "+code)
	rec := httptest.NewRecorder()
	app.overlaySocket(rec, req)
	if rec.Code != 401 || len(app.overlay.values) != 0 {
		t.Fatal("expired ticket accepted or retained")
	}
}
