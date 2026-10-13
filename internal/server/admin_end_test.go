package server

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/meeting"
)

func TestAdminEndRequiresSessionAdministratorOriginAndCSRF(t *testing.T) {
	for _, tc := range []struct {
		name, user, admins, origin, csrf string
		status                           int
	}{
		{"anonymous", "", "admin", "https://example.test", "", 401},
		{"non-admin", "owner", "admin", "https://example.test", "valid", 403},
		{"admin-disabled", "admin", "", "https://example.test", "valid", 403},
		{"cross-site", "admin", "admin", "https://evil.test", "valid", 403},
		{"missing-origin", "admin", "admin", "", "valid", 403},
		{"bad-csrf", "admin", "admin", "https://example.test", "invalid", 403},
		{"missing-csrf", "admin", "admin", "https://example.test", "", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := auth.NewStore("https://example.test")
			h := meeting.New(meeting.Config{})
			room, _ := h.Create(meeting.User{ID: "owner"})
			handler := New(Config{Auth: a, Hub: h, AdminUserIDs: tc.admins})
			body, _ := json.Marshal(map[string]any{"roomIds": []string{room.ID}})
			req := httptest.NewRequest("POST", "https://example.test/api/admin/rooms/end?userId=admin", strings.NewReader(string(body)))
			if tc.user != "" {
				s, _ := a.NewSession(meeting.User{ID: tc.user}, time.Now().Add(time.Hour))
				req.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: s.ID})
				if tc.csrf == "valid" {
					req.Header.Set("X-CSRF-Token", s.CSRF)
				} else {
					req.Header.Set("X-CSRF-Token", tc.csrf)
				}
			}
			req.Header.Set("Origin", tc.origin)
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)
			if res.Code != tc.status {
				t.Fatalf("status=%d want %d", res.Code, tc.status)
			}
			if _, err := h.Get(room.ID); err != nil {
				t.Fatal("denied request ended room", err)
			}
		})
	}
}

func TestAdminEndsSelectedRoomsOwnedByOtherUsers(t *testing.T) {
	a := auth.NewStore("https://example.test")
	h := meeting.New(meeting.Config{})
	first, _ := h.Create(meeting.User{ID: "first-owner"})
	second, _ := h.Create(meeting.User{ID: "second-owner"})
	kept, _ := h.Create(meeting.User{ID: "other-owner"})
	s, _ := a.NewSession(meeting.User{ID: "admin"}, time.Now().Add(time.Hour))
	handler := New(Config{Auth: a, Hub: h, AdminUserIDs: "admin,second-admin"})
	missing := strings.Repeat("x", 32)
	body, _ := json.Marshal(map[string]any{"roomIds": []string{first.ID, second.ID, first.ID, missing}})
	res := adminEndRequest(handler, s, string(body))
	if res.Code != 200 {
		t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
	}
	var result struct {
		Results []meeting.EndResult `json:"results"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	want := []meeting.EndResult{{ID: first.ID, Status: "ended"}, {ID: second.ID, Status: "ended"}, {ID: missing, Status: "not_found"}}
	if len(result.Results) != len(want) {
		t.Fatalf("results=%+v", result.Results)
	}
	for i := range want {
		if result.Results[i] != want[i] {
			t.Fatalf("results=%+v", result.Results)
		}
	}
	for _, id := range []string{first.ID, second.ID} {
		if _, err := h.Get(id); err != meeting.ErrNotFound {
			t.Fatal("selected room still exists", err)
		}
	}
	if _, err := h.Get(kept.ID); err != nil {
		t.Fatal("unselected room ended", err)
	}
	if res.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("missing cache protection")
	}
}

func adminEndRequest(handler http.Handler, s *auth.Session, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "https://example.test/api/admin/rooms/end", strings.NewReader(body))
	req.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: s.ID})
	req.Header.Set("Origin", "https://example.test")
	req.Header.Set("X-CSRF-Token", s.CSRF)
	req.Header.Set("Content-Type", "application/json")
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func TestAdminEndRejectsInvalidSelectionBeforeEndingAnyRoom(t *testing.T) {
	for _, name := range []string{"empty", "null", "missing", "empty-id", "invalid-id", "long-id", "wrong-type", "unknown-field", "trailing-json", "oversized", "too-many"} {
		t.Run(name, func(t *testing.T) {
			a := auth.NewStore("https://example.test")
			h := meeting.New(meeting.Config{})
			room, _ := h.Create(meeting.User{ID: "owner"})
			s, _ := a.NewSession(meeting.User{ID: "admin"}, time.Now().Add(time.Hour))
			handler := New(Config{Auth: a, Hub: h, AdminUserIDs: "admin"})
			valid := `{"roomIds":["` + room.ID + `"]}`
			bodies := map[string]string{
				"empty": `{"roomIds":[]}`, "null": `{"roomIds":null}`, "missing": `{}`,
				"empty-id":      `{"roomIds":["` + room.ID + `",""]}`,
				"invalid-id":    `{"roomIds":["` + room.ID + `","../../../api/me"]}`,
				"long-id":       `{"roomIds":["` + room.ID + `","` + strings.Repeat("a", 200) + `"]}`,
				"wrong-type":    `{"roomIds":["` + room.ID + `",123]}`,
				"unknown-field": `{"roomIds":["` + room.ID + `"],"all":true}`,
				"trailing-json": valid + ` {}`, "oversized": valid + strings.Repeat(" ", 16<<10),
				"too-many": `{"roomIds":[` + strings.Repeat(`"`+room.ID+`",`, 100) + `"` + room.ID + `"]}`,
			}
			res := adminEndRequest(handler, s, bodies[name])
			if res.Code != 400 {
				t.Fatalf("status=%d body=%s", res.Code, res.Body.String())
			}
			if _, err := h.Get(room.ID); err != nil {
				t.Fatal("invalid request partially ended rooms", err)
			}
		})
	}
}

func TestAdminEndExpiredSessionCannotEndRooms(t *testing.T) {
	a := auth.NewStore("https://example.test")
	h := meeting.New(meeting.Config{})
	room, _ := h.Create(meeting.User{ID: "owner"})
	s, _ := a.NewSession(meeting.User{ID: "admin"}, time.Now().Add(-time.Second))
	res := adminEndRequest(New(Config{Auth: a, Hub: h, AdminUserIDs: "admin"}), s, `{"roomIds":["`+room.ID+`"]}`)
	if res.Code != 401 {
		t.Fatal(res.Code)
	}
	if _, err := h.Get(room.ID); err != nil {
		t.Fatal(err)
	}
}

func TestAdminEndClosesActualWebSocketsAndRejectsReconnect(t *testing.T) {
	ts := httptest.NewUnstartedServer(nil)
	a := auth.NewStore("https://" + ts.Listener.Addr().String())
	h := meeting.New(meeting.Config{})
	ts.Config.Handler = New(Config{Auth: a, Hub: h, AdminUserIDs: "admin"})
	ts.StartTLS()
	defer ts.Close()
	owner, _ := a.NewSession(meeting.User{ID: "owner"}, time.Now().Add(time.Hour))
	viewer, _ := a.NewSession(meeting.User{ID: "viewer"}, time.Now().Add(time.Hour))
	admin, _ := a.NewSession(meeting.User{ID: "admin"}, time.Now().Add(time.Hour))
	room, _ := h.Create(owner.User)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	endpoint := "wss" + strings.TrimPrefix(ts.URL, "https") + "/api/rooms/" + room.ID + "/ws"
	dial := func(s *auth.Session) (*websocket.Conn, *http.Response, error) {
		return websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPClient: ts.Client(), HTTPHeader: http.Header{"Origin": {ts.URL}, "Cookie": {auth.SessionCookie + "=" + s.ID}}})
	}
	p, _, err := dial(owner)
	if err != nil {
		t.Fatal(err)
	}
	defer p.CloseNow()
	v, _, err := dial(viewer)
	if err != nil {
		t.Fatal(err)
	}
	defer v.CloseNow()
	_, err = h.Action(room.ID, owner.User.ID, "start", "")
	if err != nil {
		t.Fatal(err)
	}
	res := do(t, ts, admin, "POST", "/api/admin/rooms/end", `{"roomIds":["`+room.ID+`"]}`, ts.URL)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.StatusCode)
	}
	for _, conn := range []*websocket.Conn{p, v} {
		for {
			if _, _, err = conn.Read(ctx); err != nil {
				break
			}
		}
		if websocket.CloseStatus(err) != websocket.StatusPolicyViolation || !strings.Contains(err.Error(), "meeting ended by administrator") {
			t.Fatal("socket not ended by administrator", err)
		}
	}
	if _, res, err := dial(viewer); err == nil || res == nil || res.StatusCode != 404 {
		t.Fatal("reconnected ended room", err)
	}
}
