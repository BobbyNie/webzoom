package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/coder/websocket"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/media"
	"webzoom/internal/meeting"
)

type Config struct {
	Auth                    *auth.Manager
	Hub                     *meeting.Hub
	StaticDir, MetricsToken string
}
type app struct{ Config }

func New(c Config) http.Handler {
	a := &app{c}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok\n")) })
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ready\n")) })
	mux.HandleFunc("GET /auth/login", a.Auth.Login)
	mux.HandleFunc("GET /auth/callback", a.Auth.Callback)
	mux.HandleFunc("POST /auth/logout", a.secure(func(w http.ResponseWriter, r *http.Request, s *auth.Session) {
		a.Auth.Delete(s.ID)
		a.Hub.RevokeSession(s.ID)
		a.Auth.ClearCookie(w)
		w.WriteHeader(204)
	}))
	mux.HandleFunc("GET /api/me", a.secure(func(w http.ResponseWriter, r *http.Request, s *auth.Session) {
		reply(w, 200, map[string]any{"user": s.User, "csrf": s.CSRF, "expiresAt": s.ExpiresAt})
	}))
	mux.HandleFunc("POST /api/rooms", a.secure(func(w http.ResponseWriter, r *http.Request, s *auth.Session) {
		room, e := a.Hub.Create(s.User)
		if e != nil {
			fail(w, e)
			return
		}
		reply(w, 201, room)
	}))
	mux.HandleFunc("GET /api/rooms/{id}", a.secure(func(w http.ResponseWriter, r *http.Request, s *auth.Session) {
		room, e := a.Hub.Get(r.PathValue("id"))
		if e != nil {
			fail(w, e)
			return
		}
		reply(w, 200, room)
	}))
	mux.HandleFunc("POST /api/rooms/{id}/actions", a.secure(a.action))
	mux.HandleFunc("GET /api/rooms/{id}/ws", a.secure(a.socket))
	mux.HandleFunc("GET /metrics", a.metrics)
	mux.HandleFunc("GET /", a.static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=()")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
		w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		w.Header().Set("Cache-Control", "no-store")
		mux.ServeHTTP(w, r)
	})
}

type protected func(http.ResponseWriter, *http.Request, *auth.Session)

func (a *app) secure(next protected) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s, ok := a.Auth.Session(r)
		if !ok {
			http.Error(w, "authentication required", 401)
			return
		}
		if r.Method != "GET" && !a.Auth.CheckMutation(r, s) {
			http.Error(w, "origin or CSRF check failed", 403)
			return
		}
		next(w, r, s)
	}
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, e error) {
	status := 400
	switch {
	case errors.Is(e, meeting.ErrNotFound):
		status = 404
	case errors.Is(e, meeting.ErrForbidden):
		status = 403
	case errors.Is(e, meeting.ErrConflict):
		status = 409
	case errors.Is(e, meeting.ErrCapacity):
		status = 429
	}
	http.Error(w, e.Error(), status)
}
func (a *app) action(w http.ResponseWriter, r *http.Request, s *auth.Session) {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	var v struct {
		Action string `json:"action"`
		Target string `json:"target"`
	}
	if d.Decode(&v) != nil || d.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid action", 400)
		return
	}
	room, e := a.Hub.Action(r.PathValue("id"), s.User.ID, v.Action, v.Target)
	if e != nil {
		fail(w, e)
		return
	}
	reply(w, 200, room)
}
func (a *app) socket(w http.ResponseWriter, r *http.Request, s *auth.Session) {
	if r.Header.Get("Origin") != a.Auth.Origin() {
		http.Error(w, "origin rejected", 403)
		return
	}
	p, e := a.Hub.Join(r.PathValue("id"), s.User, s.ID)
	if e != nil {
		fail(w, e)
		return
	}
	defer a.Hub.Leave(p)
	conn, e := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if e != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(media.MaxFrameSize)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		defer cancel()
		window := time.Now()
		controls := 0
		for {
			typ, data, e := conn.Read(ctx)
			if e != nil {
				return
			}
			if _, ok := a.Auth.ByID(s.ID); !ok {
				return
			}
			if typ == websocket.MessageBinary {
				if e = a.Hub.Publish(p, data); e != nil {
					conn.Close(websocket.StatusPolicyViolation, "invalid publisher or video frame")
					return
				}
				continue
			}
			if len(data) > 4096 {
				return
			}
			if time.Since(window) >= time.Second {
				window = time.Now()
				controls = 0
			}
			controls++
			if controls > 20 {
				return
			}
			var msg struct {
				Type       string `json:"type"`
				Level      int    `json:"level"`
				ClientTime int64  `json:"clientTime"`
			}
			if json.Unmarshal(data, &msg) != nil {
				return
			}
			switch msg.Type {
			case "keyframe":
				a.Hub.RequestKeyframe(p)
			case "quality":
				if a.Hub.ReportQuality(p, msg.Level) != nil {
					return
				}
			case "feedback":
				a.Hub.Feedback(p, msg.Level)
			case "clock":
				payload, _ := json.Marshal(map[string]any{"type": "clock", "clientTime": msg.ClientTime, "serverTime": time.Now().UnixMilli()})
				c, stop := context.WithTimeout(ctx, time.Second)
				e = conn.Write(c, websocket.MessageText, payload)
				stop()
				if e != nil {
					return
				}
			default:
				return
			}
		}
	}()
	expiry := time.NewTimer(time.Until(s.ExpiresAt))
	defer expiry.Stop()
	check := time.NewTicker(2 * time.Second)
	defer check.Stop()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	write := func(typ websocket.MessageType, b []byte) bool {
		c, stop := context.WithTimeout(ctx, time.Second)
		defer stop()
		if conn.Write(c, typ, b) != nil {
			return false
		}
		if typ == websocket.MessageBinary {
			a.Hub.Metrics.Egress.Add(uint64(len(b)))
		}
		return true
	}
	for {
		select {
		case <-p.Done:
			conn.Close(websocket.StatusPolicyViolation, p.Reason)
			return
		case <-ctx.Done():
			return
		case <-expiry.C:
			a.Hub.RevokeSession(s.ID)
			conn.Close(websocket.StatusPolicyViolation, "session expired")
			return
		case <-check.C:
			if _, ok := a.Auth.ByID(s.ID); !ok {
				a.Hub.RevokeSession(s.ID)
				conn.Close(websocket.StatusPolicyViolation, "session expired")
				return
			}
		case <-ping.C:
			c, stop := context.WithTimeout(ctx, 5*time.Second)
			e := conn.Ping(c)
			stop()
			if e != nil {
				return
			}
		case evt := <-p.Events:
			b, _ := json.Marshal(evt)
			if !write(websocket.MessageText, b) {
				return
			}
		case <-p.Media.Notify:
			if b, ok := p.Media.Pop(); ok {
				if !write(websocket.MessageBinary, b) {
					return
				}
			}
		}
	}
}
func (a *app) metrics(w http.ResponseWriter, r *http.Request) {
	if a.MetricsToken == "" {
		http.NotFound(w, r)
		return
	}
	expected := "Bearer " + a.MetricsToken
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(expected)) != 1 {
		http.Error(w, "authentication required", 401)
		return
	}
	rooms, connections, queued := a.Hub.Counts()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, "webzoom_rooms %d\nwebzoom_connections %d\nwebzoom_queued_frames %d\nwebzoom_ingress_bytes_total %d\nwebzoom_egress_bytes_total %d\nwebzoom_dropped_frames_total %d\nwebzoom_congestion_reports_total %d\n", rooms, connections, queued, a.Hub.Metrics.Ingress.Load(), a.Hub.Metrics.Egress.Load(), a.Hub.Metrics.Dropped.Load(), a.Hub.Metrics.Degraded.Load())
}
func (a *app) static(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && !strings.HasPrefix(r.URL.Path, "/m/") && !strings.HasPrefix(r.URL.Path, "/assets/") && r.URL.Path != "/favicon.svg" {
		http.NotFound(w, r)
		return
	}
	name := "index.html"
	if strings.HasPrefix(r.URL.Path, "/assets/") || r.URL.Path == "/favicon.svg" {
		name = strings.TrimPrefix(r.URL.Path, "/")
		if strings.Contains(name, "..") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	path := filepath.Join(a.StaticDir, name)
	if _, e := os.Stat(path); e != nil {
		http.Error(w, "frontend unavailable", 503)
		return
	}
	http.ServeFile(w, r, path)
}
