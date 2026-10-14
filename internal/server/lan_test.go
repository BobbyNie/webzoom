package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/lan"
	"webzoom/internal/media"
	"webzoom/internal/meeting"
)

func TestLANWebSocketAuthenticatedHandshakeAndSignedFeed(t *testing.T) {
	ts := httptest.NewUnstartedServer(nil)
	origin := "https://" + ts.Listener.Addr().String()
	a := auth.NewStore(origin)
	h := meeting.New(meeting.Config{LAN: meeting.LANConfig{Enabled: true}})
	ts.Config.Handler = New(Config{Auth: a, Hub: h})
	ts.StartTLS()
	defer ts.Close()
	owner := meeting.User{ID: "owner"}
	viewer := meeting.User{ID: "viewer"}
	session, _ := a.NewSession(viewer, time.Now().Add(time.Hour))
	r, _ := h.Create(owner)
	p, _ := h.Join(r.ID, owner, "pub")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	endpoint := "wss" + strings.TrimPrefix(ts.URL, "https") + "/api/rooms/" + r.ID + "/ws?lan=1"
	headers := http.Header{"Origin": []string{origin}, "Cookie": []string{auth.SessionCookie + "=" + session.ID}}
	conn, _, e := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPClient: ts.Client(), HTTPHeader: headers})
	if e != nil {
		t.Fatal(e)
	}
	defer conn.CloseNow()
	send := func(v any) {
		b, _ := json.Marshal(v)
		if e := conn.Write(ctx, websocket.MessageText, b); e != nil {
			t.Fatal(e)
		}
	}
	send(map[string]any{"type": "lan", "lan": map[string]any{"op": "ready"}})
	state, _ := h.Action(r.ID, owner.ID, "start", "")
	var config meeting.LANState
	for {
		typ, b, e := conn.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if typ == websocket.MessageBinary {
			t.Fatal("media before native acknowledgement")
		}
		var ev meeting.Event
		json.Unmarshal(b, &ev)
		if ev.Type == "lan" && ev.LAN.Role == "relay" && ev.LAN.Epoch == state.Epoch {
			config = *ev.LAN
			break
		}
	}
	send(map[string]any{"type": "lan", "lan": map[string]any{"op": "configured", "generation": config.Generation}})
	send(map[string]any{"type": "clock"})
	for {
		_, b, e := conn.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		var ev meeting.Event
		json.Unmarshal(b, &ev)
		if ev.Type == "clock" {
			break
		}
	}
	raw := (media.Frame{Epoch: state.Epoch, Sequence: 1, Key: true, Width: 640, Height: 360, Payload: []byte{1, 2}}).Marshal()
	if e := h.Publish(p, raw); e != nil {
		t.Fatal(e)
	}
	for {
		typ, b, e := conn.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if typ != websocket.MessageBinary {
			continue
		}
		pub, _ := base64.StdEncoding.DecodeString(config.Public)
		room, _ := lan.ParseID(config.Room)
		gen, _ := lan.ParseID(config.Generation)
		got, e := lan.Verify(pub, room, gen, b)
		if e != nil || !bytes.Equal(got, raw) {
			t.Fatal("signed WSS mismatch", e)
		}
		break
	}
	a.Delete(session.ID)
	h.RevokeSession(session.ID)
	for {
		if _, _, e := conn.Read(ctx); e != nil {
			break
		}
	}
}
func TestLANPolicyRequiresAuthenticationAndIsDisabledByDefault(t *testing.T) {
	ts, a, _ := testApp(t)
	res := do(t, ts, nil, "GET", "/api/lan", "", ts.URL)
	res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal(res.StatusCode)
	}
	s, _ := a.NewSession(meeting.User{ID: "u"}, time.Now().Add(time.Hour))
	res = do(t, ts, s, "GET", "/api/lan", "", ts.URL)
	defer res.Body.Close()
	var policy struct{ Enabled bool }
	if json.NewDecoder(res.Body).Decode(&policy) != nil || policy.Enabled || res.StatusCode != 200 {
		t.Fatal("bad default policy")
	}
}
