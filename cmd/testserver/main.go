//go:build testtools

// Test-only TLS application and signed OIDC provider. Never built into the image.
package main

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/coreos/go-oidc/v3/oidc"
	"html/template"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/meeting"
	"webzoom/internal/server"
)

func fixtureOrigin() string {
	port := os.Getenv("WEBZOOM_TEST_PORT")
	if port == "" {
		port = "8443"
	}
	return "https://127.0.0.1:" + port
}

func fixtureTokenSeconds() int {
	n, err := strconv.Atoi(os.Getenv("WEBZOOM_TEST_TOKEN_SECONDS"))
	if err != nil || n < 5 {
		return 3600
	}
	return n
}

func main() {
	lifetime := fixtureTokenSeconds()
	origin := fixtureOrigin()
	key, _ := rsa.GenerateKey(rand.Reader, 2048)
	var issuer string
	var mu sync.Mutex
	codes := map[string]url.Values{}
	refreshes := map[string]url.Values{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
	})
	mux.HandleFunc("GET /keys", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]any{"kty": "RSA", "kid": "test", "use": "sig", "alg": "RS256", "n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())}}})
	})
	login := template.Must(template.New("login").Parse(`<!doctype html><html lang="zh-CN"><title>Test OIDC</title><body><h1>测试身份服务</h1><form method="post">{{range $key,$values := .}}{{range $values}}<input type="hidden" name="{{$key}}" value="{{.}}">{{end}}{{end}}<label>用户名<input name="username" required></label><button type="submit">登录</button></form></body></html>`))
	mux.HandleFunc("GET /authorize", func(w http.ResponseWriter, r *http.Request) { login.Execute(w, r.URL.Query()) })
	mux.HandleFunc("POST /authorize", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		b := make([]byte, 24)
		rand.Read(b)
		code := base64.RawURLEncoding.EncodeToString(b)
		mu.Lock()
		codes[code] = r.Form
		mu.Unlock()
		redirect, _ := url.Parse(r.Form.Get("redirect_uri"))
		q := redirect.Query()
		q.Set("code", code)
		q.Set("state", r.Form.Get("state"))
		redirect.RawQuery = q.Encode()
		http.Redirect(w, r, redirect.String(), 302)
	})
	mux.HandleFunc("POST /token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		mu.Lock()
		var v url.Values
		var ok bool
		if r.Form.Get("grant_type") == "refresh_token" {
			v, ok = refreshes[r.Form.Get("refresh_token")]
			delete(refreshes, r.Form.Get("refresh_token"))
		} else {
			v, ok = codes[r.Form.Get("code")]
			delete(codes, r.Form.Get("code"))
			sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			ok = ok && base64.RawURLEncoding.EncodeToString(sum[:]) == v.Get("code_challenge")
		}
		if !ok {
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(map[string]any{"error": "invalid_grant"})
			return
		}
		b := make([]byte, 24)
		rand.Read(b)
		refresh := base64.RawURLEncoding.EncodeToString(b)
		refreshes[refresh] = v
		mu.Unlock()
		claims, _ := json.Marshal(map[string]any{"iss": issuer, "sub": v.Get("username"), "aud": "webzoom-test", "exp": time.Now().Add(time.Duration(lifetime) * time.Second).Unix(), "iat": time.Now().Unix(), "nonce": v.Get("nonce"), "name": v.Get("username")})
		unsigned := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","kid":"test"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims)
		hash := sha256.Sum256([]byte(unsigned))
		sig, _ := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, hash[:])
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"access_token": "test-access", "token_type": "Bearer", "expires_in": lifetime, "refresh_token": refresh, "id_token": unsigned + "." + base64.RawURLEncoding.EncodeToString(sig)})
	})
	provider := httptest.NewTLSServer(mux)
	defer provider.Close()
	issuer = provider.URL
	listener, e := net.Listen("tcp", strings.TrimPrefix(origin, "https://"))
	if e != nil {
		log.Fatal(e)
	}
	manager, e := auth.New(oidc.ClientContext(context.Background(), provider.Client()), auth.Config{PublicURL: origin, Issuer: issuer, ClientID: "webzoom-test", ClientSecret: "test-secret"})
	if e != nil {
		log.Fatal(e)
	}
	hub := meeting.New(meeting.Config{BrowserRelayEnabled: os.Getenv("BROWSER_RELAY_ENABLED") == "true"})
	app := httptest.NewUnstartedServer(server.New(server.Config{Auth: manager, Hub: hub, StaticDir: "web/dist", MetricsToken: "test-metrics", AdminUserIDs: os.Getenv("ADMIN_USER_IDS")}))
	app.Listener.Close()
	app.Listener = listener
	app.StartTLS()
	defer app.Close()
	fmt.Println("TEST_ONLY_READY " + origin)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()
}
