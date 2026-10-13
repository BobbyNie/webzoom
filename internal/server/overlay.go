package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"github.com/coder/websocket"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
	"webzoom/internal/auth"
)

type overlayTicket struct {
	room, user, session string
	epoch               uint32
	width, height       int
	expires             time.Time
}
type overlayTickets struct {
	sync.Mutex
	values map[[32]byte]overlayTicket
}

func (a *app) pairOverlay(w http.ResponseWriter, r *http.Request, s *auth.Session) {
	w.Header().Set("Cache-Control", "no-store")
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	var v struct {
		Epoch   uint32 `json:"epoch"`
		Surface string `json:"surface"`
		Width   int    `json:"width"`
		Height  int    `json:"height"`
	}
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(&v) != nil || d.Decode(new(any)) != io.EOF || v.Surface != "monitor" || v.Width < 100 || v.Height < 100 || v.Width > 16384 || v.Height > 16384 {
		http.Error(w, "select an entire monitor before pairing", 400)
		return
	}
	if err := a.Hub.CheckOverlayPublisher(r.PathValue("id"), s.User.ID, s.ID, v.Epoch); err != nil {
		fail(w, err)
		return
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		http.Error(w, "pairing unavailable", 503)
		return
	}
	code := base64.RawURLEncoding.EncodeToString(raw)
	now := time.Now()
	expiry := now.Add(60 * time.Second)
	a.overlay.Lock()
	if a.overlay.values == nil {
		a.overlay.values = make(map[[32]byte]overlayTicket)
	}
	for key, t := range a.overlay.values {
		if !now.Before(t.expires) || (t.room == r.PathValue("id") && t.session == s.ID) {
			delete(a.overlay.values, key)
		}
	}
	if len(a.overlay.values) >= 1024 {
		a.overlay.Unlock()
		http.Error(w, "pairing capacity reached", 429)
		return
	}
	a.overlay.values[sha256.Sum256([]byte(code))] = overlayTicket{r.PathValue("id"), s.User.ID, s.ID, v.Epoch, v.Width, v.Height, expiry}
	a.overlay.Unlock()
	reply(w, 200, map[string]any{"pairing": a.Auth.Origin() + "/#webzoom-overlay=" + code, "expiresAt": expiry})
}

func (a *app) stopOverlay(w http.ResponseWriter, r *http.Request, s *auth.Session) {
	a.overlay.Lock()
	for key, t := range a.overlay.values {
		if t.room == r.PathValue("id") && t.session == s.ID {
			delete(a.overlay.values, key)
		}
	}
	a.overlay.Unlock()
	a.Hub.StopOverlay(r.PathValue("id"), s.User.ID, s.ID)
	w.WriteHeader(http.StatusNoContent)
}

func (a *app) overlaySocket(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// Browser-origin requests and URL credentials are never accepted. The native
	// helper sends its single-use capability in Authorization over verified TLS.
	value := r.Header.Get("Authorization")
	if r.Header.Get("Origin") != "" || r.URL.RawQuery != "" || !strings.HasPrefix(value, "Bearer ") || len(value) != 50 {
		http.Error(w, "invalid pairing", 401)
		return
	}
	hash := sha256.Sum256([]byte(strings.TrimPrefix(value, "Bearer ")))
	a.overlay.Lock()
	ticket, ok := a.overlay.values[hash]
	delete(a.overlay.values, hash)
	a.overlay.Unlock()
	if !ok || !time.Now().Before(ticket.expires) {
		http.Error(w, "pairing expired or already used", 401)
		return
	}
	if _, ok = a.Auth.ByID(ticket.session); !ok {
		http.Error(w, "session expired", 401)
		return
	}
	o, err := a.Hub.SubscribeOverlay(ticket.room, ticket.user, ticket.session, ticket.epoch)
	if err != nil {
		fail(w, err)
		return
	}
	defer a.Hub.UnsubscribeOverlay(o)
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(256)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	// This socket is receive-only; even one data message from the helper ends it.
	go func() { _, _, _ = conn.Read(ctx); cancel() }()
	write := func(v any) error {
		data, e := json.Marshal(v)
		if e != nil {
			return e
		}
		c, stop := context.WithTimeout(ctx, 2*time.Second)
		defer stop()
		return conn.Write(c, websocket.MessageText, data)
	}
	if write(map[string]any{"type": "overlay-ready", "width": ticket.width, "height": ticket.height, "epoch": ticket.epoch}) != nil {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-o.Done:
			return
		case ev := <-o.Events:
			if _, ok := a.Auth.ByID(ticket.session); !ok || !a.Hub.OverlayAlive(o) {
				return
			}
			if write(ev) != nil {
				return
			}
		case <-ticker.C:
			if _, ok := a.Auth.ByID(ticket.session); !ok || !a.Hub.OverlayAlive(o) {
				return
			}
			if write(map[string]string{"type": "overlay-heartbeat"}) != nil {
				return
			}
		}
	}
}
