package server

import (
	"context"
	"errors"
	"github.com/coder/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/meeting"
)

func bandwidthRequest(handler http.Handler, s *auth.Session, body, origin, csrf string) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", "https://example.test/api/admin/bandwidth", strings.NewReader(body))
	if s != nil {
		req.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: s.ID})
	}
	req.Header.Set("Origin", origin)
	req.Header.Set("X-CSRF-Token", csrf)
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	return res
}

func TestBandwidthSettingRequiresAdministratorAndCSRF(t *testing.T) {
	for _, tc := range []struct {
		user, origin, csrf string
		expired            bool
		status             int
	}{
		{"", "https://example.test", "valid", false, 401},
		{"viewer", "https://example.test", "valid", false, 403},
		{"admin", "https://evil.test", "valid", false, 403},
		{"admin", "", "valid", false, 403},
		{"admin", "https://example.test", "invalid", false, 403},
		{"admin", "https://example.test", "", false, 403},
		{"admin", "https://example.test", "valid", true, 401},
	} {
		t.Run(tc.user+tc.origin+tc.csrf, func(t *testing.T) {
			a := auth.NewStore("https://example.test")
			h := meeting.New(meeting.Config{})
			var s *auth.Session
			csrf := tc.csrf
			if tc.user != "" {
				s, _ = a.NewSession(meeting.User{ID: tc.user}, time.Now().Add(time.Hour))
				if csrf == "valid" {
					csrf = s.CSRF
				}
				if tc.expired {
					a.Delete(s.ID)
				}
			}
			res := bandwidthRequest(New(Config{Auth: a, Hub: h, AdminUserIDs: "admin"}), s, `{"limitMbps":10}`, tc.origin, csrf)
			if res.Code != tc.status || h.BandwidthStatus().LimitMbps != 200 {
				t.Fatal(res.Code, res.Body.String())
			}
		})
	}
}

func TestBandwidthSettingStrictValidationAndSaveFailure(t *testing.T) {
	a := auth.NewStore("https://example.test")
	s, _ := a.NewSession(meeting.User{ID: "admin"}, time.Now().Add(time.Hour))
	h := meeting.New(meeting.Config{})
	handler := New(Config{Auth: a, Hub: h, AdminUserIDs: "admin"})
	for _, body := range []string{`{}`, `null`, `{"limitMbps":0}`, `{"limitMbps":-1}`, `{"limitMbps":1000001}`, `{"limitMbps":"10"}`, `{"limitMbps":1.5}`, `{"limitMbps":10,"extra":1}`, `{"limitMbps":10}{}`, `{"limitMbps":10}` + strings.Repeat(" ", 4096)} {
		res := bandwidthRequest(handler, s, body, "https://example.test", s.CSRF)
		if res.Code != 400 || h.BandwidthStatus().LimitMbps != 200 {
			t.Fatal("invalid body changed setting", res.Code, body)
		}
	}
	res := bandwidthRequest(handler, s, `{"limitMbps":50}`, "https://example.test", s.CSRF)
	if res.Code != 200 || h.BandwidthStatus().LimitMbps != 50 || !strings.Contains(res.Body.String(), `"limitMbps":50`) {
		t.Fatal(res.Code, res.Body.String())
	}
	failing := meeting.New(meeting.Config{SaveBandwidthLimit: func(int) error { return errors.New("volume read-only") }})
	res = bandwidthRequest(New(Config{Auth: a, Hub: failing, AdminUserIDs: "admin"}), s, `{"limitMbps":30}`, "https://example.test", s.CSRF)
	if res.Code != 503 || failing.BandwidthStatus().LimitMbps != 200 || strings.Contains(res.Body.String(), "volume read-only") {
		t.Fatal(res.Code, res.Body.String())
	}
}

func TestBandwidthBlocksCreatePreflightAndDirectWSSButNotExistingActions(t *testing.T) {
	ts, a, h := testApp(t)
	s, _ := a.NewSession(meeting.User{ID: "owner"}, time.Now().Add(time.Hour))
	room, _ := h.Create(s.User)
	p, _ := h.Join(room.ID, s.User, s.ID)
	h.RecordEgress(p, 125000001)
	for _, tc := range []struct{ method, path, body string }{
		{"POST", "/api/rooms", "{}"}, {"GET", "/api/rooms/" + room.ID, ""},
	} {
		res := do(t, ts, s, tc.method, tc.path, tc.body, ts.URL)
		res.Body.Close()
		if res.StatusCode != 503 || res.Header.Get("Retry-After") != "5" || res.Header.Get("X-WebZoom-Error") != "bandwidth_limit" {
			t.Fatal(res.StatusCode, res.Header)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	viewer, _ := a.NewSession(meeting.User{ID: "new-viewer"}, time.Now().Add(time.Hour))
	conn, res, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(ts.URL, "https")+"/api/rooms/"+room.ID+"/ws", &websocket.DialOptions{HTTPClient: ts.Client(), HTTPHeader: http.Header{"Origin": {ts.URL}, "Cookie": {auth.SessionCookie + "=" + viewer.ID}}})
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil || res == nil || res.StatusCode != 503 {
		t.Fatal("direct WSS bypassed bandwidth policy", err, res)
	}
	if _, connections, _ := h.Counts(); connections != 1 {
		t.Fatal("rejected WSS left ghost participant")
	}
	res = do(t, ts, s, "GET", "/api/rooms", "", ts.URL)
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal("existing list unavailable")
	}
	for _, action := range []string{"start", "stop", "end"} {
		res = do(t, ts, s, "POST", "/api/rooms/"+room.ID+"/actions", `{"action":"`+action+`"}`, ts.URL)
		res.Body.Close()
		if res.StatusCode != 200 {
			t.Fatal("existing operation blocked", action, res.StatusCode)
		}
	}
}
