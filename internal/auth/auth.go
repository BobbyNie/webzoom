// Package auth keeps OIDC credentials and sessions exclusively on the server.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"webzoom/internal/meeting"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const SessionCookie = "__Host-webzoom-session"
const loginCookie = "__Host-webzoom-login"

type Config struct{ PublicURL, Issuer, ClientID, ClientSecret string }
type Session struct {
	ID        string
	CSRF      string
	User      meeting.User
	ExpiresAt time.Time
}
type pendingLogin struct {
	Nonce, Verifier, Next string
	ExpiresAt             time.Time
}
type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
	pending  map[string]pendingLogin
	origin   string
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
	client   *http.Client
}

func NewStore(origin string) *Manager {
	return &Manager{sessions: map[string]*Session{}, pending: map[string]pendingLogin{}, origin: origin}
}
func New(ctx context.Context, c Config) (*Manager, error) {
	u, e := url.Parse(c.PublicURL)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("PUBLIC_URL must be an HTTPS origin")
	}
	if c.Issuer == "" || c.ClientID == "" || c.ClientSecret == "" {
		return nil, errors.New("OIDC configuration is required")
	}
	client, _ := ctx.Value(oauth2.HTTPClient).(*http.Client)
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	ctx = oidc.ClientContext(ctx, client)
	provider, e := oidc.NewProvider(ctx, c.Issuer)
	if e != nil {
		return nil, e
	}
	var discovery struct {
		JWKS string `json:"jwks_uri"`
	}
	if e := provider.Claims(&discovery); e != nil {
		return nil, e
	}
	for _, endpoint := range []string{provider.Endpoint().AuthURL, provider.Endpoint().TokenURL, discovery.JWKS} {
		u, err := url.Parse(endpoint)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil {
			return nil, errors.New("OIDC discovery endpoints must use HTTPS")
		}
	}
	m := NewStore(strings.TrimSuffix(c.PublicURL, "/"))
	m.client = client
	m.verifier = provider.Verifier(&oidc.Config{ClientID: c.ClientID})
	m.oauth = oauth2.Config{ClientID: c.ClientID, ClientSecret: c.ClientSecret, Endpoint: provider.Endpoint(), RedirectURL: m.origin + "/auth/callback", Scopes: []string{oidc.ScopeOpenID, "profile"}}
	return m, nil
}
func randomToken() string {
	b := make([]byte, 32)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func cookie(w http.ResponseWriter, name, value string, expires time.Time) {
	age := int(time.Until(expires).Seconds())
	if value == "" {
		age = -1
	}
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode, Expires: expires, MaxAge: age})
}
func safeNext(s string) string {
	if strings.HasPrefix(s, "/m/") && !strings.ContainsAny(s, "\\\r\n?#") && len(s) < 128 {
		return s
	}
	return "/"
}
func (m *Manager) Login(w http.ResponseWriter, r *http.Request) {
	m.mu.Lock()
	now := time.Now()
	for k, v := range m.pending {
		if !now.Before(v.ExpiresAt) {
			delete(m.pending, k)
		}
	}
	if len(m.pending) >= 1024 {
		m.mu.Unlock()
		http.Error(w, "too many login requests", 429)
		return
	}
	state := randomToken()
	p := pendingLogin{Nonce: randomToken(), Verifier: oauth2.GenerateVerifier(), Next: safeNext(r.URL.Query().Get("next")), ExpiresAt: now.Add(5 * time.Minute)}
	if c, e := r.Cookie(loginCookie); e == nil {
		delete(m.pending, c.Value)
	}
	m.pending[state] = p
	m.mu.Unlock()
	cookie(w, loginCookie, state, p.ExpiresAt)
	http.Redirect(w, r, m.oauth.AuthCodeURL(state, oidc.Nonce(p.Nonce), oauth2.S256ChallengeOption(p.Verifier)), http.StatusFound)
}
func (m *Manager) Callback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	c, e := r.Cookie(loginCookie)
	if e != nil || state == "" || subtle.ConstantTimeCompare([]byte(state), []byte(c.Value)) != 1 {
		http.Error(w, "invalid login state", 400)
		return
	}
	m.mu.Lock()
	p, ok := m.pending[state]
	delete(m.pending, state)
	m.mu.Unlock()
	cookie(w, loginCookie, "", time.Unix(0, 0))
	if !ok || !time.Now().Before(p.ExpiresAt) || r.URL.Query().Get("code") == "" {
		http.Error(w, "invalid or expired login", 400)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	ctx = oidc.ClientContext(ctx, m.client)
	tok, e := m.oauth.Exchange(ctx, r.URL.Query().Get("code"), oauth2.VerifierOption(p.Verifier))
	if e != nil {
		http.Error(w, "identity provider exchange failed", 401)
		return
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok {
		http.Error(w, "missing identity token", 401)
		return
	}
	id, e := m.verifier.Verify(ctx, raw)
	if e != nil || subtle.ConstantTimeCompare([]byte(id.Nonce), []byte(p.Nonce)) != 1 {
		http.Error(w, "invalid identity token", 401)
		return
	}
	var claims struct {
		Name     string `json:"name"`
		Username string `json:"preferred_username"`
	}
	if e = id.Claims(&claims); e != nil || id.Subject == "" {
		http.Error(w, "invalid identity", 401)
		return
	}
	name := claims.Name
	if name == "" {
		name = claims.Username
	}
	if name == "" {
		name = id.Subject
	}
	if len([]rune(name)) > 128 {
		name = string([]rune(name)[:128])
	}
	expiry := id.Expiry
	if !tok.Expiry.IsZero() && tok.Expiry.Before(expiry) {
		expiry = tok.Expiry
	}
	if max := time.Now().Add(8 * time.Hour); max.Before(expiry) {
		expiry = max
	}
	if !time.Now().Before(expiry) {
		http.Error(w, "expired identity", 401)
		return
	}
	s, e := m.NewSession(meeting.User{ID: id.Subject, Name: name}, expiry)
	if e != nil {
		http.Error(w, "session capacity reached", 503)
		return
	}
	if old, e := r.Cookie(SessionCookie); e == nil {
		m.Delete(old.Value)
	}
	cookie(w, SessionCookie, s.ID, s.ExpiresAt)
	http.Redirect(w, r, p.Next, 302)
}
func (m *Manager) NewSession(u meeting.User, expiry time.Time) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for k, s := range m.sessions {
		if !time.Now().Before(s.ExpiresAt) {
			delete(m.sessions, k)
		}
	}
	if len(m.sessions) >= 10000 {
		return nil, errors.New("session capacity reached")
	}
	s := &Session{ID: randomToken(), CSRF: randomToken(), User: u, ExpiresAt: expiry}
	m.sessions[s.ID] = s
	return s, nil
}
func (m *Manager) Session(r *http.Request) (*Session, bool) {
	c, e := r.Cookie(SessionCookie)
	if e != nil {
		return nil, false
	}
	return m.ByID(c.Value)
}
func (m *Manager) ByID(id string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[id]
	if !ok {
		return nil, false
	}
	if !time.Now().Before(s.ExpiresAt) {
		delete(m.sessions, id)
		return nil, false
	}
	return s, true
}
func (m *Manager) CheckMutation(r *http.Request, s *Session) bool {
	return r.Header.Get("Origin") == m.origin && subtle.ConstantTimeCompare([]byte(r.Header.Get("X-CSRF-Token")), []byte(s.CSRF)) == 1
}
func (m *Manager) Origin() string                    { return m.origin }
func (m *Manager) Delete(id string)                  { m.mu.Lock(); defer m.mu.Unlock(); delete(m.sessions, id) }
func (m *Manager) ClearCookie(w http.ResponseWriter) { cookie(w, SessionCookie, "", time.Unix(0, 0)) }
