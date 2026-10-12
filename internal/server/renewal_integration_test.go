package server

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
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coreos/go-oidc/v3/oidc"
	"io"
	"strings"
	"webzoom/internal/auth"
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

func newRenewalLogin(t *testing.T, lifetime int, origin string) (*auth.Manager, *auth.Session, *renewalProvider) {
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
	m, err := auth.New(ctx, auth.Config{PublicURL: origin, Issuer: ts.URL, ClientID: "webzoom", ClientSecret: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	out := httptest.NewRecorder()
	m.Login(out, httptest.NewRequest("GET", origin+"/auth/login", nil))
	loc, _ := url.Parse(out.Header().Get("Location"))
	p.nonce = loc.Query().Get("nonce")
	p.challenge = loc.Query().Get("code_challenge")
	req := httptest.NewRequest("GET", origin+"/auth/callback?code=code&state="+loc.Query().Get("state"), nil).WithContext(ctx)
	req.AddCookie(out.Result().Cookies()[0])
	callback := httptest.NewRecorder()
	m.Callback(callback, req)
	if callback.Code != 302 {
		t.Fatalf("callback: %d %s", callback.Code, callback.Body.String())
	}
	for _, cookie := range callback.Result().Cookies() {
		if cookie.Name == auth.SessionCookie && cookie.Value != "" {
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

func TestRenewalPreservesSocketBeyondOriginalDeadline(t *testing.T) {
	ts := httptest.NewUnstartedServer(nil)
	origin := "https://" + ts.Listener.Addr().String()
	a, s, _ := newRenewalLogin(t, 3, origin)
	h := meeting.New(meeting.Config{})
	ts.Config.Handler = New(Config{Auth: a, Hub: h})
	ts.StartTLS()
	defer ts.Close()
	room, _ := h.Create(s.User)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(ts.URL, "https")+"/api/rooms/"+room.ID+"/ws", &websocket.DialOptions{HTTPClient: ts.Client(), HTTPHeader: http.Header{"Origin": []string{ts.URL}, "Cookie": []string{auth.SessionCookie + "=" + s.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	res := do(t, ts, s, "POST", "/auth/refresh", "{}", ts.URL)
	var renewed struct {
		ExpiresAt time.Time `json:"expiresAt"`
	}
	err = json.NewDecoder(res.Body).Decode(&renewed)
	res.Body.Close()
	if res.StatusCode != 200 || err != nil || !renewed.ExpiresAt.After(s.ExpiresAt) {
		t.Fatalf("refresh failed: %d %v", res.StatusCode, err)
	}
	time.Sleep(time.Until(s.ExpiresAt) + 150*time.Millisecond)
	if err = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"clock","clientTime":123}`)); err != nil {
		t.Fatal(err)
	}
	for {
		_, b, e := conn.Read(ctx)
		if e != nil {
			t.Fatalf("renewed socket disconnected at old deadline: %v", e)
		}
		if strings.Contains(string(b), `"type":"clock"`) {
			break
		}
	}
}
func TestRefreshProviderFailureHTTPPolicy(t *testing.T) {
	for _, failure := range []string{"invalid_grant", "unavailable"} {
		t.Run(failure, func(t *testing.T) {
			ts := httptest.NewUnstartedServer(nil)
			origin := "https://" + ts.Listener.Addr().String()
			a, s, p := newRenewalLogin(t, 30, origin)
			h := meeting.New(meeting.Config{})
			ts.Config.Handler = New(Config{Auth: a, Hub: h})
			ts.StartTLS()
			defer ts.Close()
			room, _ := h.Create(s.User)
			peer, _ := h.Join(room.ID, s.User, s.ID)
			defer h.Leave(peer)
			p.mu.Lock()
			p.failure = failure
			p.mu.Unlock()
			res := do(t, ts, s, "POST", "/auth/refresh", "{}", ts.URL)
			b, _ := io.ReadAll(res.Body)
			res.Body.Close()
			if failure == "unavailable" {
				if res.StatusCode != 503 {
					t.Fatal(res.StatusCode)
				}
				if _, ok := a.ByID(s.ID); !ok {
					t.Fatal("transient failure revoked session")
				}
			} else {
				if res.StatusCode != 401 {
					t.Fatalf("status %d %s", res.StatusCode, b)
				}
				select {
				case <-peer.Done:
				default:
					t.Fatal("rejected refresh did not revoke media")
				}
				if len(res.Cookies()) != 1 || res.Cookies()[0].MaxAge != -1 {
					t.Fatal("cookie not cleared")
				}
			}
		})
	}
}
