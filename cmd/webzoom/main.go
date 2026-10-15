package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/bandwidth"
	"webzoom/internal/meeting"
	"webzoom/internal/server"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// secret accepts an environment value or a mounted secret, never both.
func secret(name string) (string, error) {
	value, path := os.Getenv(name), os.Getenv(name+"_FILE")
	if value != "" && path != "" {
		return "", fmt.Errorf("configure only %s or %s_FILE", name, name)
	}
	if path == "" {
		return value, nil
	}
	b, e := os.ReadFile(path)
	if e != nil {
		return "", fmt.Errorf("cannot read %s_FILE", name)
	}
	if len(b) > 16384 {
		return "", fmt.Errorf("%s_FILE exceeds 16 KiB", name)
	}
	return strings.TrimSpace(string(b)), nil
}

// loadTestLimit is disabled unless an explicit non-negative limit is configured.
func loadTestLimit(name string) (int, error) {
	value := os.Getenv(name)
	if value == "" {
		return 0, nil
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer (0 disables the load-test limit)", name)
	}
	return n, nil
}
func bandwidthLimit() (int, error) {
	n, err := strconv.Atoi(env("TOTAL_BANDWIDTH_LIMIT_MBPS", "200"))
	if err != nil || !bandwidth.ValidLimit(n) {
		return 0, fmt.Errorf("TOTAL_BANDWIDTH_LIMIT_MBPS must be an integer between 1 and 1000000")
	}
	return n, nil
}

func loadBandwidthStore() (bandwidth.FileStore, int, error) {
	store := bandwidth.FileStore{Path: env("BANDWIDTH_CONFIG_FILE", "/data/bandwidth.json")}
	initial, err := bandwidthLimit()
	if err != nil {
		return store, 0, err
	}
	limit, err := store.Load(initial)
	if err == nil {
		err = store.Save(limit)
	}
	return store, limit, err
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	issuer := os.Getenv("OIDC_ISSUER")
	u, e := url.Parse(issuer)
	if e != nil || u.Scheme != "https" || u.Host == "" {
		slog.Error("OIDC_ISSUER must use HTTPS")
		os.Exit(1)
	}
	clientSecret, e := secret("OIDC_CLIENT_SECRET")
	if e != nil {
		slog.Error(e.Error())
		os.Exit(1)
	}
	metricsToken, e := secret("METRICS_TOKEN")
	if e != nil {
		slog.Error(e.Error())
		os.Exit(1)
	}
	maxRooms, e := loadTestLimit("LOAD_TEST_MAX_ROOMS")
	if e != nil {
		slog.Error(e.Error())
		os.Exit(1)
	}
	maxViewers, e := loadTestLimit("LOAD_TEST_MAX_VIEWERS")
	if e != nil {
		slog.Error(e.Error())
		os.Exit(1)
	}
	if maxRooms > 0 || maxViewers > 0 {
		slog.Warn("load-test capacity limits enabled; do not use for normal deployment", "rooms", maxRooms, "viewers", maxViewers)
	}
	store, limit, e := loadBandwidthStore()
	if e != nil {
		slog.Error("bandwidth configuration initialization failed; check persistent volume and permissions", "error", e)
		os.Exit(1)
	}
	startup, stop := context.WithTimeout(ctx, 20*time.Second)
	manager, e := auth.New(startup, auth.Config{PublicURL: os.Getenv("PUBLIC_URL"), Issuer: issuer, ClientID: os.Getenv("OIDC_CLIENT_ID"), ClientSecret: clientSecret})
	stop()
	if e != nil {
		slog.Error("OIDC initialization failed; check issuer, TLS trust and client configuration", "error", e)
		os.Exit(1)
	}
	lanConfig, e := loadLANConfig()
	if e != nil {
		slog.Error(e.Error())
		os.Exit(1)
	}
	hub := meeting.New(meeting.Config{LAN: lanConfig, MaxRooms: maxRooms, MaxViewers: maxViewers, BandwidthLimitMbps: limit, SaveBandwidthLimit: store.Save})
	clientPort, _ := strconv.Atoi(os.Getenv("LAN_CLIENT_PORT"))
	handler := server.New(server.Config{Auth: manager, Hub: hub, StaticDir: env("STATIC_DIR", "web/dist"), LANClientDir: env("LAN_CLIENT_DIR", "artifacts/lan-release"), LANClientPort: clientPort, MetricsToken: metricsToken, AdminUserIDs: os.Getenv("ADMIN_USER_IDS")})
	srv := &http.Server{Addr: env("LISTEN_ADDR", ":8080"), Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	go func() {
		timer := time.NewTicker(time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-timer.C:
				hub.Sweep()
			}
		}
	}()
	go func() {
		slog.Info("WebZoom started; HTTPS termination is required at the ingress", "address", srv.Addr)
		if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
			slog.Error("HTTP server failed", "error", e)
			cancel()
		}
	}()
	<-ctx.Done()
	shutdown, end := context.WithTimeout(context.Background(), 10*time.Second)
	defer end()
	srv.Shutdown(shutdown)
}
