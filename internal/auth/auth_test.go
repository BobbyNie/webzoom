package auth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"webzoom/internal/meeting"

	"github.com/coreos/go-oidc/v3/oidc"
)

func TestSessionsExpireAndCSRF(t *testing.T) {
	m := NewStore("https://share.example")
	s, e := m.NewSession(meeting.User{ID: "u"}, time.Now().Add(time.Minute))
	if e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("POST", "https://share.example/api/rooms", nil)
	r.AddCookie(&http.Cookie{Name: SessionCookie, Value: s.ID})
	if _, ok := m.Session(r); !ok {
		t.Fatal("missing session")
	}
	if m.CheckMutation(r, s) {
		t.Fatal("missing origin and csrf allowed")
	}
	r.Header.Set("Origin", "https://share.example")
	r.Header.Set("X-CSRF-Token", s.CSRF)
	if !m.CheckMutation(r, s) {
		t.Fatal("valid csrf rejected")
	}
	r.Header.Set("Origin", "https://evil.example")
	if m.CheckMutation(r, s) {
		t.Fatal("cross site allowed")
	}
	m.Delete(s.ID)
	if _, ok := m.Session(r); ok {
		t.Fatal("deleted session")
	}
	expired, _ := m.NewSession(meeting.User{ID: "u"}, time.Now().Add(-time.Second))
	r.Header.Set("Cookie", SessionCookie+"="+expired.ID)
	if _, ok := m.Session(r); ok {
		t.Fatal("expired session")
	}
}

func TestOIDCCodePKCENonceAndReplay(t *testing.T) {
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	var issuer, nonce, challenge string
	invalidClaim := ""
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
	})
	mux.HandleFunc("GET /keys", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "test", "use": "sig", "alg": "RS256", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
	})
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if base64.RawURLEncoding.EncodeToString(sum[:]) != challenge {
			http.Error(w, "pkce", 400)
			return
		}
		n := nonce
		if invalidClaim == "nonce" {
			n = "wrong"
		}
		claims := map[string]any{"iss": issuer, "sub": "alice", "aud": "webzoom", "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Unix(), "nonce": n, "name": "Alice"}
		switch invalidClaim {
		case "issuer":
			claims["iss"] = "https://evil.example"
		case "audience":
			claims["aud"] = "other-client"
		case "expired":
			claims["exp"] = time.Now().Add(-time.Hour).Unix()
		}
		body, _ := json.Marshal(claims)
		header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","kid":"test"}`))
		unsigned := header + "." + base64.RawURLEncoding.EncodeToString(body)
		hash := sha256.Sum256([]byte(unsigned))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
		if invalidClaim == "signature" {
			sig[0] ^= 0xff
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"access_token": "access", "token_type": "Bearer", "expires_in": 3600, "id_token": unsigned + "." + base64.RawURLEncoding.EncodeToString(sig)})
	})
	ts := httptest.NewTLSServer(mux)
	defer ts.Close()
	issuer = ts.URL
	ctx := oidc.ClientContext(context.Background(), ts.Client())
	m, e := New(ctx, Config{PublicURL: "https://share.example", Issuer: issuer, ClientID: "webzoom", ClientSecret: "secret"})
	if e != nil {
		t.Fatal(e)
	}
	for _, invalid := range []string{"", "nonce", "issuer", "audience", "expired", "signature"} {
		invalidClaim = invalid
		rr := httptest.NewRecorder()
		m.Login(rr, httptest.NewRequest("GET", "https://share.example/auth/login?next=/m/test", nil))
		loc, _ := url.Parse(rr.Header().Get("Location"))
		q := loc.Query()
		nonce = q.Get("nonce")
		challenge = q.Get("code_challenge")
		if nonce == "" || challenge == "" || q.Get("code_challenge_method") != "S256" {
			t.Fatal("missing oidc protection")
		}
		cookies := rr.Result().Cookies()
		if len(cookies) == 0 || !cookies[0].Secure || !cookies[0].HttpOnly {
			t.Fatal("unsafe login cookie")
		}
		r := httptest.NewRequest("GET", "https://share.example/auth/callback?code=ok&state="+q.Get("state"), nil).WithContext(ctx)
		r.AddCookie(cookies[0])
		out := httptest.NewRecorder()
		m.Callback(out, r)
		if invalid != "" {
			if out.Code != http.StatusUnauthorized {
				t.Fatal("bad nonce accepted", out.Code)
			}
		} else {
			if out.Code != 302 || out.Header().Get("Location") != "/m/test" {
				t.Fatal("callback failed", out.Code, out.Body.String())
			}
			found := false
			for _, c := range out.Result().Cookies() {
				if c.Name == SessionCookie && c.Value != "" {
					found = true
					if !c.Secure || !c.HttpOnly || c.Path != "/" {
						t.Fatal("unsafe session cookie")
					}
				}
			}
			if !found {
				t.Fatal("no session")
			}
		}
		replay := httptest.NewRecorder()
		m.Callback(replay, r)
		if replay.Code != 400 {
			t.Fatal("state replay accepted")
		}
	}
}
func TestRejectWrongStateAndExternalRedirect(t *testing.T) {
	m := NewStore("https://share.example")
	m.oauth.Endpoint.AuthURL = "https://issuer.example/auth"
	rr := httptest.NewRecorder()
	m.Login(rr, httptest.NewRequest("GET", "https://share.example/auth/login?next=//evil.example", nil))
	u, _ := url.Parse(rr.Header().Get("Location"))
	state := u.Query().Get("state")
	m.mu.Lock()
	next := m.pending[state].Next
	m.mu.Unlock()
	if next != "/" {
		t.Fatal("open redirect")
	}
	req := httptest.NewRequest("GET", "https://share.example/auth/callback?state="+state+"&code=x", nil)
	out := httptest.NewRecorder()
	m.Callback(out, req)
	if out.Code != 400 {
		t.Fatal("missing browser binding accepted")
	}
	if strings.Contains(out.Body.String(), state) {
		t.Fatal("state leaked")
	}
}
