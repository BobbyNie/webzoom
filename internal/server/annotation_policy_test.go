package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/meeting"
)

func TestAnnotationExportPolicyAuthenticatedAndOptIn(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "default-off", true: "explicitly-enabled"}[enabled], func(t *testing.T) {
			a := auth.NewStore("https://localhost")
			h := meeting.New(meeting.Config{})
			ts := httptest.NewTLSServer(New(Config{Auth: a, Hub: h, AnnotationExportEnabled: enabled}))
			defer ts.Close()
			res := do(t, ts, nil, http.MethodGet, "/api/annotation-policy", "", "")
			res.Body.Close()
			if res.StatusCode != 401 {
				t.Fatal("anonymous policy", res.StatusCode)
			}
			session, _ := a.NewSession(meeting.User{ID: "u", Name: "User"}, time.Now().Add(time.Hour))
			res = do(t, ts, session, http.MethodGet, "/api/annotation-policy", "", "")
			defer res.Body.Close()
			var result struct {
				ExportEnabled bool `json:"exportEnabled"`
			}
			if err := json.NewDecoder(res.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != 200 || result.ExportEnabled != enabled {
				t.Fatal(res.StatusCode, result)
			}
		})
	}
}
