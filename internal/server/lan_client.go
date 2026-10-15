package server

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"net/http"
	"path/filepath"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/lansetup"
)

type clientDownload struct {
	Enabled   bool   `json:"enabled"`
	Available bool   `json:"available"`
	Origin    string `json:"origin"`
	Port      int    `json:"port"`
	SHA256    string `json:"sha256,omitempty"`
	Reason    string `json:"reason,omitempty"`
	data      []byte
}

func (a *app) prepareClient() {
	d := &clientDownload{Enabled: a.Hub.LANEnabled(), Origin: a.Auth.Origin(), Port: a.LANClientPort}
	a.client = d
	if !d.Enabled {
		d.Reason = "disabled"
		return
	}
	if a.LANClientPort < 1024 || a.LANClientPort > 65535 {
		d.Reason = "port_not_configured"
		return
	}
	if a.LANClientDir == "" {
		d.Reason = "client_unavailable"
		return
	}
	raw, err := lansetup.SiteExecutable(filepath.Join(a.LANClientDir, "WebZoom-LAN-Setup.exe"), d.Origin, d.Port)
	if err != nil {
		d.Reason = "client_unavailable"
		return
	}
	d.data = raw
	d.SHA256 = fmt.Sprintf("%x", sha256.Sum256(raw))
	d.Available = true
}

func (a *app) clientInfo(w http.ResponseWriter, r *http.Request, s *auth.Session) {
	w.Header().Set("Cache-Control", "no-store")
	reply(w, 200, a.client)
}
func (a *app) downloadClient(w http.ResponseWriter, r *http.Request, s *auth.Session) {
	w.Header().Set("Cache-Control", "no-store")
	// Reject cross-site embedding/navigation even with a valid session cookie.
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" && site != "none" {
		http.Error(w, "same-origin download required", 403)
		return
	}
	if !a.client.Available {
		http.Error(w, "LAN client is not configured by the administrator", 503)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="WebZoom-LAN-Setup.exe"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-WebZoom-SHA256", a.client.SHA256)
	http.ServeContent(w, r, "WebZoom-LAN-Setup.exe", time.Time{}, bytes.NewReader(a.client.data))
}
