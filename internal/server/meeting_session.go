package server

import (
	"context"
	"errors"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/meeting"
)

// No activity is inferred from mouse movement. Only an authenticated, live
// meeting connection may renew; expiry, logout and the fixed cap still win.
func (a *app) maintainMeetingSession(ctx context.Context, p *meeting.Peer) {
	for {
		session, ok := a.Auth.ByID(p.SessionID)
		if !ok {
			a.Hub.RevokeSession(p.SessionID)
			return
		}
		delay := time.Until(session.ExpiresAt) / 3
		if delay > 30*time.Second {
			delay = 30 * time.Second
		}
		if delay < time.Second {
			delay = time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-p.Done:
			timer.Stop()
			return
		case <-timer.C:
		}
		// Cancel queued work on disconnect. An already-started token rotation
		// finishes within the auth timeout so its replacement is not discarded.
		renewCtx, cancel := context.WithCancel(ctx)
		done := make(chan struct{})
		go func() {
			select {
			case <-p.Done:
				cancel()
			case <-done:
			case <-renewCtx.Done():
			}
		}()
		_, err := a.Auth.Renew(renewCtx, p.SessionID)
		close(done)
		cancel()
		if errors.Is(err, auth.ErrExpired) {
			a.Hub.RevokeSession(p.SessionID)
			return
		}
	}
}
