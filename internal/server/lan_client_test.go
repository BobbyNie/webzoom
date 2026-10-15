package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/lansetup"
	"webzoom/internal/meeting"
)

func clientTemplate(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	b := &lansetup.Bundle{Config: lansetup.Config{ConfigureOnInstall: true, ExtensionID: "hmeoffkckocfjcblblfhpmjcighdehfa"}, Files: map[string][]byte{}}
	for _, name := range []string{"manifest.json", "background.js", "content.js", "policy.js", "popup.html", "popup.js", "messages.js", "diagnostic-client.js"} {
		b.Files["extension/"+name] = []byte("fixture")
	}
	b.Files["extension/manifest.json"] = []byte(`{"permissions":["nativeMessaging"]}`)
	b.Files["native/webzoom-lan-host.exe"] = []byte("MZ-host")
	b.Files["native/bundle.json"], _ = json.Marshal(b.Config)
	stub := filepath.Join(dir, "stub")
	os.WriteFile(stub, []byte("MZ-setup"), 0600)
	if err := b.WriteExecutable(stub, filepath.Join(dir, "WebZoom-LAN-Setup.exe")); err != nil {
		t.Fatal(err)
	}
	return dir
}
func TestAuthenticatedSiteClientDownload(t *testing.T) {
	origin := "https://approved.example"
	a := auth.NewStore(origin)
	h := meeting.New(meeting.Config{LAN: meeting.LANConfig{Enabled: true}})
	handler := New(Config{Auth: a, Hub: h, LANClientDir: clientTemplate(t), LANClientPort: 34567})
	session, _ := a.NewSession(meeting.User{ID: "alice"}, time.Now().Add(time.Hour))
	call := func(method, path string, login bool, site string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.Host = "evil.example"
		r.Header.Set("X-Forwarded-Host", "evil.example")
		r.Header.Set("Sec-Fetch-Site", site)
		if login {
			r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: session.ID})
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/api/lan/client", "/api/lan/client/setup.exe"} {
		if w := call("GET", path, false, ""); w.Code != 401 {
			t.Fatal(w.Code)
		}
	}
	var info clientDownload
	w := call("GET", "/api/lan/client", true, "")
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &info) != nil || !info.Available || info.Origin != origin || info.Port != 34567 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call("GET", "/api/lan/client/setup.exe", true, "same-origin")
	raw := w.Body.Bytes()
	if w.Code != 200 || !bytes.HasPrefix(raw, []byte("MZ")) || w.Header().Get("Content-Disposition") != `attachment; filename="WebZoom-LAN-Setup.exe"` || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-WebZoom-SHA256") != fmt.Sprintf("%x", sha256.Sum256(raw)) || info.SHA256 != w.Header().Get("X-WebZoom-SHA256") {
		t.Fatal(w.Code, w.Header())
	}
	target := filepath.Join(t.TempDir(), "download.exe")
	os.WriteFile(target, raw, 0600)
	b, err := lansetup.ReadBundle(target)
	if err != nil || b.Config.Origin != origin || b.Config.Port != 34567 || b.Config.ConfigureOnInstall {
		t.Fatal("untrusted host used", err)
	}
	if w = call("HEAD", "/api/lan/client/setup.exe", true, "same-origin"); w.Code != 200 || w.Body.Len() != 0 {
		t.Fatal("HEAD", w.Code)
	}
	if w = call("GET", "/api/lan/client/setup.exe", true, "cross-site"); w.Code != 403 {
		t.Fatal(w.Code)
	}
	if w = call("GET", "/api/lan/client/other.exe", true, ""); w.Code != 404 {
		t.Fatal(w.Code)
	}
	a.Delete(session.ID)
	if w = call("GET", "/api/lan/client/setup.exe", true, ""); w.Code != 401 {
		t.Fatal("revoked session downloaded", w.Code)
	}
}
func TestClientDistributionFailClosed(t *testing.T) {
	for _, tc := range []struct {
		enabled     bool
		port        int
		dir, reason string
	}{{false, 34567, "", "disabled"}, {true, 0, "", "port_not_configured"}, {true, 80, "", "port_not_configured"}, {true, 34567, t.TempDir(), "client_unavailable"}} {
		a := auth.NewStore("https://approved.example")
		h := meeting.New(meeting.Config{LAN: meeting.LANConfig{Enabled: tc.enabled}})
		handler := New(Config{Auth: a, Hub: h, LANClientDir: tc.dir, LANClientPort: tc.port})
		s, _ := a.NewSession(meeting.User{ID: "alice"}, time.Now().Add(time.Hour))
		for _, path := range []string{"/api/lan/client", "/api/lan/client/setup.exe"} {
			r := httptest.NewRequest("GET", path, nil)
			r.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: s.ID})
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if path == "/api/lan/client" {
				var v clientDownload
				json.Unmarshal(w.Body.Bytes(), &v)
				if v.Available || v.Reason != tc.reason {
					t.Fatal(v)
				}
			} else if w.Code != 503 {
				t.Fatal(w.Code)
			}
			io.Copy(io.Discard, w.Result().Body)
		}
	}
}
