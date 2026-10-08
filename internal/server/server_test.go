package server

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/media"
	"webzoom/internal/meeting"
)

func testApp(t *testing.T) (*httptest.Server, *auth.Manager, *meeting.Hub) {
	t.Helper()
	ts := httptest.NewUnstartedServer(nil)
	origin := "https://" + ts.Listener.Addr().String()
	a := auth.NewStore(origin)
	h := meeting.New(meeting.Config{})
	ts.Config.Handler = New(Config{Auth: a, Hub: h, StaticDir: "../../web/dist", MetricsToken: "metrics"})
	ts.StartTLS()
	t.Cleanup(ts.Close)
	return ts, a, h
}
func do(t *testing.T, ts *httptest.Server, s *auth.Session, method, path, body, origin string) *http.Response {
	t.Helper()
	r, _ := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if s != nil {
		r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: s.ID})
		r.Header.Set("X-CSRF-Token", s.CSRF)
	}
	r.Header.Set("Origin", origin)
	r.Header.Set("Content-Type", "application/json")
	res, e := ts.Client().Do(r)
	if e != nil {
		t.Fatal(e)
	}
	return res
}
func TestAPIAuthenticationAndCSRF(t *testing.T) {
	ts, a, _ := testApp(t)
	res := do(t, ts, nil, "POST", "/api/rooms", "{}", ts.URL)
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal(res.StatusCode)
	}
	s, _ := a.NewSession(meeting.User{ID: "alice", Name: "Alice"}, time.Now().Add(time.Hour))
	res = do(t, ts, s, "POST", "/api/rooms", "{}", "https://evil.example")
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal(res.StatusCode)
	}
	res = do(t, ts, s, "POST", "/api/rooms", "{}", ts.URL)
	defer res.Body.Close()
	if res.StatusCode != 201 {
		t.Fatal(res.StatusCode)
	}
	var r meeting.Snapshot
	json.NewDecoder(res.Body).Decode(&r)
	if len(r.ID) < 24 {
		t.Fatal("weak room link")
	}
	if res.Header.Get("Permissions-Policy") != "camera=(), microphone=()" {
		t.Fatal("missing media policy")
	}
}
func TestWebSocketOriginAndVideoRelay(t *testing.T) {
	ts, a, h := testApp(t)
	u := meeting.User{ID: "u", Name: "Owner"}
	v := meeting.User{ID: "v", Name: "Viewer"}
	s, _ := a.NewSession(u, time.Now().Add(time.Hour))
	vs, _ := a.NewSession(v, time.Now().Add(time.Hour))
	r, _ := h.Create(u)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	endpoint := "wss" + strings.TrimPrefix(ts.URL, "https") + "/api/rooms/" + r.ID + "/ws"
	dial := func(s *auth.Session, origin string) (*websocket.Conn, *http.Response, error) {
		hdr := http.Header{"Origin": []string{origin}}
		if s != nil {
			hdr.Set("Cookie", auth.SessionCookie+"="+s.ID)
		}
		return websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPClient: ts.Client(), HTTPHeader: hdr})
	}
	if _, res, e := dial(nil, ts.URL); e == nil || res.StatusCode != 401 {
		t.Fatal("anonymous socket")
	}
	if _, res, e := dial(s, "https://evil.example"); e == nil || res.StatusCode != 403 {
		t.Fatal("cross-origin socket")
	}
	p, _, e := dial(s, ts.URL)
	if e != nil {
		t.Fatal(e)
	}
	defer p.CloseNow()
	w, _, e := dial(vs, ts.URL)
	if e != nil {
		t.Fatal(e)
	}
	defer w.CloseNow()
	state, e := h.Action(r.ID, u.ID, "start", "")
	if e != nil {
		t.Fatal(e)
	}
	b := (media.Frame{Epoch: state.Epoch, Sequence: 1, Key: true, Width: 1920, Height: 1080, Timestamp: 123, Payload: []byte{1}}).Marshal()
	if e = p.Write(ctx, websocket.MessageBinary, b); e != nil {
		t.Fatal(e)
	}
	for {
		typ, data, e := w.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if typ == websocket.MessageBinary {
			if string(data) != string(b) {
				t.Fatal("frame modified")
			}
			break
		}
	}
	res := do(t, ts, s, "POST", "/auth/logout", "{}", ts.URL)
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatal(res.StatusCode)
	}
	for {
		_, _, e = p.Read(ctx)
		if e != nil {
			break
		}
	}
	if websocket.CloseStatus(e) != websocket.StatusPolicyViolation {
		t.Fatal("logout did not close socket", e)
	}
	if state, _ = h.Get(r.ID); state.Active {
		t.Fatal("logout left sharing active")
	}
}
func TestMetricsRequireSeparateToken(t *testing.T) {
	ts, _, _ := testApp(t)
	res := do(t, ts, nil, "GET", "/metrics", "", ts.URL)
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal("public metrics")
	}
	req, _ := http.NewRequest("GET", ts.URL+"/metrics", nil)
	req.Header.Set("Authorization", "Bearer metrics")
	res, e := ts.Client().Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(fmt.Sprint(res.StatusCode))
	}
}

func TestSocketExpiresWithoutIncomingTraffic(t *testing.T) {
	ts, a, h := testApp(t)
	s, _ := a.NewSession(meeting.User{ID: "short"}, time.Now().Add(500*time.Millisecond))
	room, _ := h.Create(s.User)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, e := websocket.Dial(ctx, "wss"+strings.TrimPrefix(ts.URL, "https")+"/api/rooms/"+room.ID+"/ws", &websocket.DialOptions{HTTPClient: ts.Client(), HTTPHeader: http.Header{"Origin": []string{ts.URL}, "Cookie": []string{auth.SessionCookie + "=" + s.ID}}})
	if e != nil {
		t.Fatal(e)
	}
	defer conn.CloseNow()
	for {
		_, _, e = conn.Read(ctx)
		if e != nil {
			break
		}
	}
	if websocket.CloseStatus(e) != websocket.StatusPolicyViolation {
		t.Fatalf("expired socket not closed: %v", e)
	}
}
