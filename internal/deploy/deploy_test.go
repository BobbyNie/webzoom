//go:build deploymenttests

// These opt-in tests run temporary Docker containers, never a production deployment.
package deploy_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"github.com/coder/websocket"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/media"
	"webzoom/internal/meeting"
	"webzoom/internal/server"
)

const nginxImage = "nginxinc/nginx-unprivileged:stable-alpine@sha256:15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3"

func docker(t *testing.T, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	b, e := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if e != nil {
		t.Fatalf("docker %s: %v\n%s", args[0], e, b)
	}
	return strings.TrimSpace(string(b))
}
func container(t *testing.T, args ...string) string {
	t.Helper()
	name := fmt.Sprintf("webzoom-test-%d", time.Now().UnixNano())
	all := append([]string{"run", "-d", "--name", name}, args...)
	docker(t, all...)
	t.Cleanup(func() { docker(t, "rm", "-f", name) })
	return name
}
func port(t *testing.T, name, port string) string {
	return strings.TrimPrefix(docker(t, "port", name, port), "127.0.0.1:")
}
func certificates(t *testing.T) (string, *http.Client, tls.Certificate) {
	t.Helper()
	dir := t.TempDir()
	if e := os.Chmod(dir, 0755); e != nil {
		t.Fatal(e)
	}
	key, e := rsa.GenerateKey(rand.Reader, 2048)
	if e != nil {
		t.Fatal(e)
	}
	cert := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "WebZoom test only"}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), DNSNames: []string{"example.com"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, e := x509.CreateCertificate(rand.Reader, cert, cert, &key.PublicKey, key)
	if e != nil {
		t.Fatal(e)
	}
	pub := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	priv := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	for name, b := range map[string][]byte{"fullchain.pem": pub, "privkey.pem": priv} {
		if e = os.WriteFile(filepath.Join(dir, name), b, 0644); e != nil {
			t.Fatal(e)
		}
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(pub)
	pair, e := tls.X509KeyPair(pub, priv)
	if e != nil {
		t.Fatal(e)
	}
	return dir, &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots}}}, pair
}
func waitHealthy(t *testing.T, client *http.Client, url string) {
	t.Helper()
	until := time.Now().Add(20 * time.Second)
	for time.Now().Before(until) {
		res, e := client.Get(url + "/readyz")
		if e == nil {
			res.Body.Close()
			if res.StatusCode == 200 {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("service did not become ready")
}
func TestReadOnlyImageWithDefaultNonRootUID(t *testing.T) {
	if user := docker(t, "image", "inspect", "webzoom:local", "--format", "{{.Config.User}}"); user != "65532:65532" {
		t.Fatalf("image must default to numeric non-root UID/GID, got %q", user)
	}
	checkReadOnlyImage(t, nil)
}

func TestReadOnlyImageWithArbitraryUID(t *testing.T) {
	checkReadOnlyImage(t, []string{"--user", "1001230000:0"})
}

func checkReadOnlyImage(t *testing.T, user []string) {
	t.Helper()
	dir, _, pair := certificates(t)
	listener, e := net.Listen("tcp", "0.0.0.0:0")
	if e != nil {
		t.Fatal(e)
	}
	issuer := "https://example.com:" + fmt.Sprint(listener.Addr().(*net.TCPAddr).Port)
	provider := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "authorization_endpoint": issuer + "/authorize", "token_endpoint": issuer + "/token", "jwks_uri": issuer + "/keys", "id_token_signing_alg_values_supported": []string{"RS256"}})
	}))
	provider.Listener.Close()
	provider.Listener = listener
	provider.TLS = &tls.Config{Certificates: []tls.Certificate{pair}}
	provider.StartTLS()
	defer provider.Close()
	args := append(user, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--add-host", "example.com:host-gateway", "-p", "127.0.0.1::8080", "-v", dir+":/trust:ro", "-e", "SSL_CERT_FILE=/trust/fullchain.pem", "-e", "PUBLIC_URL=https://webzoom.example.test", "-e", "OIDC_ISSUER="+issuer, "-e", "OIDC_CLIENT_ID=fixture", "-e", "OIDC_CLIENT_SECRET=test-only", "webzoom:local")
	name := container(t, args...)
	url := "http://127.0.0.1:" + port(t, name, "8080/tcp")
	waitHealthy(t, http.DefaultClient, url)
	res, e := http.Get(url + "/api/me")
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	if res.StatusCode != 401 {
		t.Fatal(res.StatusCode)
	}
	res, e = http.Get(url + "/")
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || !strings.Contains(string(body), "WebZoom") {
		t.Fatal("bundled frontend unavailable")
	}
}
func TestHTTPSProxyCarriesAuthenticatedBinaryWSS(t *testing.T) {
	dir, client, _ := certificates(t)
	upstream, e := net.Listen("tcp", "0.0.0.0:0")
	if e != nil {
		t.Fatal(e)
	}
	defer upstream.Close()
	conf, e := os.ReadFile("../../deploy/nginx.conf")
	if e != nil {
		t.Fatal(e)
	}
	conf = []byte(strings.ReplaceAll(string(conf), "app:8080", "host.docker.internal:"+fmt.Sprint(upstream.Addr().(*net.TCPAddr).Port)))
	if e = os.WriteFile(filepath.Join(dir, "nginx.conf"), conf, 0644); e != nil {
		t.Fatal(e)
	}
	name := container(t, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8443", "--tmpfs", "/tmp:uid=101,gid=101,mode=1770", "-v", dir+":/etc/webzoom/tls:ro", "-v", filepath.Join(dir, "nginx.conf")+":/etc/nginx/nginx.conf:ro", "--entrypoint", "nginx", nginxImage, "-g", "daemon off;")
	origin := "https://127.0.0.1:" + port(t, name, "8443/tcp")
	a := auth.NewStore(origin)
	h := meeting.New(meeting.Config{})
	ts := httptest.NewUnstartedServer(server.New(server.Config{Auth: a, Hub: h}))
	ts.Listener.Close()
	ts.Listener = upstream
	ts.Start()
	defer ts.Close()
	waitHealthy(t, client, origin)
	owner := meeting.User{ID: "publisher"}
	viewer := meeting.User{ID: "viewer"}
	s, _ := a.NewSession(owner, time.Now().Add(time.Minute))
	v, _ := a.NewSession(viewer, time.Now().Add(time.Minute))
	room, _ := h.Create(owner)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	dial := func(session string) *websocket.Conn {
		conn, _, e := websocket.Dial(ctx, "wss"+strings.TrimPrefix(origin, "https")+"/api/rooms/"+room.ID+"/ws", &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {auth.SessionCookie + "=" + session}}})
		if e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { conn.CloseNow() })
		return conn
	}
	p := dial(s.ID)
	watch := dial(v.ID)
	state, e := h.Action(room.ID, owner.ID, "start", "")
	if e != nil {
		t.Fatal(e)
	}
	frame := (media.Frame{Epoch: state.Epoch, Sequence: 1, Timestamp: 1, Width: 1920, Height: 1080, Key: true, Payload: []byte{0, 1, 2, 3}}).Marshal()
	if e = p.Write(ctx, websocket.MessageBinary, frame); e != nil {
		t.Fatal(e)
	}
	for {
		kind, b, e := watch.Read(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if kind == websocket.MessageBinary {
			if string(b) != string(frame) {
				t.Fatal("proxy changed payload")
			}
			break
		}
	}
	p.CloseNow()
	watch.CloseNow()
}

func TestComposeLoadTestLimitsAreDisabledByDefaultAndOptIn(t *testing.T) {
	for key, value := range map[string]string{
		"PUBLIC_URL": "https://webzoom.example.test", "OIDC_ISSUER": "https://idp.example.test/realms/company",
		"OIDC_CLIENT_ID": "webzoom", "OIDC_CLIENT_SECRET_FILE": "/tmp/test-secret", "METRICS_TOKEN_FILE": "/tmp/test-metrics",
		"TLS_CERT_FILE": "/tmp/test-cert", "TLS_KEY_FILE": "/tmp/test-key",
	} {
		t.Setenv(key, value)
	}
	for _, file := range []string{"../../compose.yaml", "../../deploy/local/compose.yaml"} {
		for _, tc := range []struct{ name, rooms, viewers, wantRooms, wantViewers string }{
			{"default", "", "", "0", "0"}, {"load-test", "5", "200", "5", "200"},
		} {
			t.Run(file+"/"+tc.name, func(t *testing.T) {
				t.Setenv("LOAD_TEST_MAX_ROOMS", tc.rooms)
				t.Setenv("LOAD_TEST_MAX_VIEWERS", tc.viewers)
				data := docker(t, "compose", "-f", file, "config", "--format", "json")
				var config struct {
					Services map[string]struct {
						Environment map[string]string `json:"environment"`
					} `json:"services"`
				}
				if err := json.Unmarshal([]byte(data), &config); err != nil {
					t.Fatal(err)
				}
				environment := config.Services["app"].Environment
				if environment["LOAD_TEST_MAX_ROOMS"] != tc.wantRooms || environment["LOAD_TEST_MAX_VIEWERS"] != tc.wantViewers {
					t.Fatal("load-test limits not forwarded with correct defaults", environment["LOAD_TEST_MAX_ROOMS"], environment["LOAD_TEST_MAX_VIEWERS"])
				}
			})
		}
	}
}
