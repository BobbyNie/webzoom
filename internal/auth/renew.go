package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

var ErrExpired = errors.New("session expired")
var ErrRefreshUnavailable = errors.New("identity provider temporarily unavailable")

// Each session serializes refresh-token rotation without blocking other sessions.
// Session snapshots contain no OIDC credentials and are safe to read concurrently.
type sessionState struct {
	Session
	refreshMu sync.Mutex
	token     *oauth2.Token
	nonce     string
	maxExpiry time.Time
}

func (m *Manager) Renew(ctx context.Context, id string) (*Session, error) {
	m.mu.Lock()
	state := m.sessions[id]
	m.mu.Unlock()
	if state == nil {
		return nil, ErrExpired
	}
	state.refreshMu.Lock()
	defer state.refreshMu.Unlock()
	if ctx.Err() != nil {
		return nil, ErrRefreshUnavailable
	}
	m.mu.Lock()
	if m.sessions[id] != state || !time.Now().Before(state.ExpiresAt) {
		delete(m.sessions, id)
		m.mu.Unlock()
		return nil, ErrExpired
	}
	snapshot := state.Session
	if time.Until(snapshot.ExpiresAt) > time.Minute || !snapshot.ExpiresAt.Before(state.maxExpiry) || state.token == nil || state.token.RefreshToken == "" {
		m.mu.Unlock()
		return &snapshot, nil
	}
	refreshToken, nonce, maxExpiry := state.token.RefreshToken, state.nonce, state.maxExpiry
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	ctx = oidc.ClientContext(ctx, m.client)
	// Force a refresh before expiry. The returned rotated refresh token replaces the old one.
	tok, err := m.oauth.TokenSource(ctx, &oauth2.Token{RefreshToken: refreshToken}).Token()
	if err != nil {
		var providerError *oauth2.RetrieveError
		if errors.As(err, &providerError) && providerError.Response.StatusCode >= 400 && providerError.Response.StatusCode < 500 && providerError.Response.StatusCode != 429 {
			m.Delete(id)
			return nil, ErrExpired
		}
		return nil, ErrRefreshUnavailable
	}
	expiry := tok.Expiry
	if value := tok.Extra("id_token"); value != nil {
		raw, ok := value.(string)
		if !ok || raw == "" {
			m.Delete(id)
			return nil, ErrExpired
		}
		identity, err := m.verifier.Verify(ctx, raw)
		if err != nil || identity.Subject != snapshot.User.ID || (identity.Nonce != "" && subtle.ConstantTimeCompare([]byte(identity.Nonce), []byte(nonce)) != 1) {
			m.Delete(id)
			return nil, ErrExpired
		}
		if identity.Expiry.Before(expiry) {
			expiry = identity.Expiry
		}
	}
	if expiry.IsZero() || !time.Now().Before(expiry) {
		m.Delete(id)
		return nil, ErrExpired
	}
	if maxExpiry.Before(expiry) {
		expiry = maxExpiry
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// Logout, expiry and cleanup must not be undone by an in-flight refresh.
	if m.sessions[id] != state || !time.Now().Before(state.ExpiresAt) {
		delete(m.sessions, id)
		return nil, ErrExpired
	}
	state.token = tok
	state.ExpiresAt = expiry
	snapshot = state.Session
	return &snapshot, nil
}
