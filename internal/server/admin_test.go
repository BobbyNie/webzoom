package server

import (
	"net/http"
	"net/http/httptest"
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
