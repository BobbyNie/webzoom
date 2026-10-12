package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"webzoom/internal/meeting"
)

type renewalProvider struct {
	mu                                sync.Mutex
	issuer, nonce, challenge, refresh string
	calls                             int
	failure, badClaim                 string
	lifetime                          int
	key                               *rsa.PrivateKey
}

func newRenewalLogin(t *testing.T, lifetime int) (*Manager, *Session, *renewalProvider) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &renewalProvider{key: key, refresh: "refresh-1", lifetime: lifetime}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"issuer": p.issuer, "authorization_endpoint": p.issuer + "/authorize", "token_endpoint": p.issuer + "/token", "jwks_uri": p.issuer + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
	})
	mux.HandleFunc("GET /keys", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "test", "use": "sig", "alg": "RS256", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
	})
	mux.HandleFunc("POST /token", p.token)
	ts := httptest.NewTLSServer(mux)
	t.Cleanup(ts.Close)
	p.issuer = ts.URL
	ctx := oidc.ClientContext(context.Background(), ts.Client())
	m, err := New(ctx, Config{PublicURL: "https://share.example", Issuer: ts.URL, ClientID: "webzoom", ClientSecret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	out := httptest.NewRecorder()
	m.Login(out, httptest.NewRequest("GET", "https://share.example/auth/login", nil))
	loc, _ := url.Parse(out.Header().Get("Location"))
	p.nonce = loc.Query().Get("nonce")
	p.challenge = loc.Query().Get("code_challenge")
	req := httptest.NewRequest("GET", "https://share.example/auth/callback?code=code&state="+loc.Query().Get("state"), nil).WithContext(ctx)
	req.AddCookie(out.Result().Cookies()[0])
	callback := httptest.NewRecorder()
	m.Callback(callback, req)
	if callback.Code != 302 {
		t.Fatalf("callback: %d %s", callback.Code, callback.Body.String())
	}
	for _, cookie := range callback.Result().Cookies() {
		if cookie.Name == SessionCookie && cookie.Value != "" {
			s, ok := m.ByID(cookie.Value)
			if !ok {
				t.Fatal("no session")
			}
			return m, s, p
		}
	}
	t.Fatal("no cookie")
	return nil, nil, nil
}
func (p *renewalProvider) token(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	defer p.mu.Unlock()
	r.ParseForm()
	life := p.lifetime
	if r.Form.Get("grant_type") == "refresh_token" {
		p.calls++
		if p.failure != "" {
			w.Header().Set("Content-Type", "application/json")
			if p.failure == "unavailable" {
				w.WriteHeader(503)
			} else {
				w.WriteHeader(400)
			}
			json.NewEncoder(w).Encode(map[string]any{"error": p.failure})
			return
		}
		if r.Form.Get("refresh_token") != p.refresh {
			http.Error(w, "invalid refresh", 400)
			return
		}
		life = 300
		p.refresh = "refresh-rotated"
	} else {
		hash := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if base64.RawURLEncoding.EncodeToString(hash[:]) != p.challenge {
			http.Error(w, "pkce", 400)
			return
		}
	}
	claims := map[string]any{"iss": p.issuer, "sub": "alice", "aud": "webzoom", "exp": time.Now().Add(time.Duration(life) * time.Second).Unix(), "iat": time.Now().Unix(), "nonce": p.nonce, "name": "Alice"}
	switch p.badClaim {
	case "subject":
		claims["sub"] = "mallory"
	case "nonce":
		claims["nonce"] = "other"
	case "audience":
		claims["aud"] = "other"
	case "issuer":
		claims["iss"] = "https://evil.example"
	case "expired":
		claims["exp"] = time.Now().Add(-time.Hour).Unix()
	}
	body, _ := json.Marshal(claims)
	unsigned := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","kid":"test"}`)) + "." + base64.RawURLEncoding.EncodeToString(body)
	hash := sha256.Sum256([]byte(unsigned))
	sig, _ := rsa.SignPKCS1v15(rand.Reader, p.key, crypto.SHA256, hash[:])
	if p.badClaim == "signature" {
		sig[0] ^= 0xff
	}
	response := map[string]any{"access_token": "access", "token_type": "Bearer", "expires_in": life, "id_token": unsigned + "." + base64.RawURLEncoding.EncodeToString(sig), "refresh_token": p.refresh}
	if p.badClaim == "malformed" {
		response["id_token"] = 42
	}
	if p.badClaim == "omitted" {
		delete(response, "id_token")
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(response)
}
func TestActiveOIDCSessionRenewsBeforeTokenExpiry(t *testing.T) {
	m, s, p := newRenewalLogin(t, 30)
	renewed, err := m.Renew(context.Background(), s.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !renewed.ExpiresAt.After(s.ExpiresAt.Add(time.Minute)) || renewed.ID != s.ID || renewed.CSRF != s.CSRF || renewed.User != s.User {
		t.Fatalf("session not renewed safely: %+v", renewed)
	}
	p.mu.Lock()
	calls := p.calls
	p.mu.Unlock()
	if calls != 1 {
		t.Fatalf("refresh calls=%d", calls)
	}
}

func TestMalformedRefreshIdentityIsRejected(t *testing.T) {
	m, s, p := newRenewalLogin(t, 30)
	p.mu.Lock()
	p.badClaim = "malformed"
	p.mu.Unlock()
	if _, err := m.Renew(context.Background(), s.ID); !errors.Is(err, ErrExpired) {
		t.Fatalf("malformed identity accepted: %v", err)
	}
	if _, ok := m.ByID(s.ID); ok {
		t.Fatal("invalid identity kept session")
	}
}

func TestConcurrentRefreshAndRotation(t *testing.T) {
	m, s, p := newRenewalLogin(t, 30)
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := m.Renew(context.Background(), s.ID); err != nil {
				t.Errorf("concurrent refresh: %v", err)
			}
		}()
	}
	wg.Wait()
	p.mu.Lock()
	calls := p.calls
	p.mu.Unlock()
	if calls != 1 {
		t.Fatalf("refresh called %d times", calls)
	}
	// Force the next refresh window without a five-minute sleep.
	m.mu.Lock()
	m.sessions[s.ID].ExpiresAt = time.Now().Add(30 * time.Second)
	m.mu.Unlock()
	if _, err := m.Renew(context.Background(), s.ID); err != nil {
		t.Fatalf("rotated token rejected: %v", err)
	}
	p.mu.Lock()
	calls = p.calls
	p.mu.Unlock()
	if calls != 2 {
		t.Fatalf("rotation calls=%d", calls)
	}
	if time.Until(s.ExpiresAt) > time.Minute {
		t.Fatal("original snapshot mutated")
	}
}

func TestRefreshRejectsInvalidIdentity(t *testing.T) {
	for _, claim := range []string{"subject", "nonce", "audience", "issuer", "expired", "signature"} {
		t.Run(claim, func(t *testing.T) {
			m, s, p := newRenewalLogin(t, 30)
			p.mu.Lock()
			p.badClaim = claim
			p.mu.Unlock()
			if _, err := m.Renew(context.Background(), s.ID); !errors.Is(err, ErrExpired) {
				t.Fatalf("invalid identity accepted: %v", err)
			}
			if _, ok := m.ByID(s.ID); ok {
				t.Fatal("invalid session not revoked")
			}
		})
	}
}
func TestRefreshFailurePolicy(t *testing.T) {
	for _, failure := range []string{"invalid_grant", "unavailable"} {
		t.Run(failure, func(t *testing.T) {
			m, s, p := newRenewalLogin(t, 30)
			p.mu.Lock()
			p.failure = failure
			p.mu.Unlock()
			_, err := m.Renew(context.Background(), s.ID)
			_, ok := m.ByID(s.ID)
			if failure == "unavailable" {
				if !errors.Is(err, ErrRefreshUnavailable) || !ok {
					t.Fatalf("transient failure revoked session: %v", err)
				}
			} else if !errors.Is(err, ErrExpired) || ok {
				t.Fatalf("invalid grant kept session: %v", err)
			}
		})
	}
}
func TestRefreshWithoutNewIdentityAndAbsoluteLimit(t *testing.T) {
	m, s, p := newRenewalLogin(t, 30)
	p.mu.Lock()
	p.badClaim = "omitted"
	p.mu.Unlock()
	max := time.Now().Add(90 * time.Second)
	m.mu.Lock()
	m.sessions[s.ID].maxExpiry = max
	m.mu.Unlock()
	renewed, err := m.Renew(context.Background(), s.ID)
	if err != nil || !renewed.ExpiresAt.Equal(max) {
		t.Fatalf("absolute limit: %+v %v", renewed, err)
	}
	m.Delete(s.ID)
	if _, err = m.Renew(context.Background(), s.ID); !errors.Is(err, ErrExpired) {
		t.Fatal("logged-out session refreshed")
	}
}
func TestIdleAndNonRefreshableSessionsExpire(t *testing.T) {
	m := NewStore("https://share.example")
	s, _ := m.NewSession(meeting.User{ID: "alice"}, time.Now().Add(time.Minute))
	renewed, err := m.Renew(context.Background(), s.ID)
	if err != nil || !renewed.ExpiresAt.Equal(s.ExpiresAt) {
		t.Fatal("session extended without refresh grant")
	}
	m.mu.Lock()
	m.sessions[s.ID].ExpiresAt = time.Now().Add(-time.Second)
	m.mu.Unlock()
	if _, err = m.Renew(context.Background(), s.ID); !errors.Is(err, ErrExpired) {
		t.Fatal("idle session revived")
	}
}
