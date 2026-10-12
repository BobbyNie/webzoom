package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/meeting"
)

func TestAdminAuthorization(t *testing.T) {
	for _, configured := range []string{"", " alice, bob ,alice,,"} {
		a := auth.NewStore("https://example.test")
		handler := New(Config{Auth: a, Hub: meeting.New(meeting.Config{}), AdminUserIDs: configured})
		for _, id := range []string{"", "alice", "bob", "Alice", "mallory"} {
			req := httptest.NewRequest("GET", "https://example.test/api/admin/overview?userId=alice", nil)
			if id != "" {
				s, _ := a.NewSession(meeting.User{ID: id, Name: "alice"}, time.Now().Add(time.Hour))
				req.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: s.ID})
			}
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)
			want := 403
			if id == "" {
				want = 401
			} else if configured != "" && (id == "alice" || id == "bob") {
				want = 200
			}
			if res.Code != want {
				t.Fatalf("config=%q id=%q status=%d want=%d", configured, id, res.Code, want)
			}
			if res.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("cacheable overview")
			}
		}
	}
}

func TestAdminOverviewReturnsOnlySummaryAndRejectsExpiredSession(t *testing.T) {
	a := auth.NewStore("https://example.test")
	h := meeting.New(meeting.Config{})
	user := meeting.User{ID: "admin", Name: "Private Name"}
	s, _ := a.NewSession(user, time.Now().Add(time.Hour))
	room, _ := h.Create(user)
	h.Join(room.ID, user, s.ID)
	handler := New(Config{Auth: a, Hub: h, AdminUserIDs: "admin"})
	req := httptest.NewRequest("GET", "https://example.test/api/admin/overview", nil)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: s.ID})
	res := httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	var got meeting.Overview
	if err := json.Unmarshal(res.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if res.Code != 200 || len(got.Rooms) != 1 || got.Rooms[0].ID != room.ID || got.Rooms[0].Participants != 1 || got.InstanceID == "" {
		t.Fatal(res.Code, res.Body.String())
	}
	for _, private := range []string{s.ID, s.CSRF, "Private Name", "ownerId", "publisherId"} {
		if strings.Contains(res.Body.String(), private) {
			t.Fatal("private data in overview")
		}
	}
	a.Delete(s.ID)
	res = httptest.NewRecorder()
	handler.ServeHTTP(res, req)
	if res.Code != 401 {
		t.Fatal("expired administrator still allowed", res.Code)
	}
}
