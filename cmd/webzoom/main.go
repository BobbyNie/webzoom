package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	"webzoom/internal/auth"
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
	startup, stop := context.WithTimeout(ctx, 20*time.Second)
	manager, e := auth.New(startup, auth.Config{PublicURL: os.Getenv("PUBLIC_URL"), Issuer: issuer, ClientID: os.Getenv("OIDC_CLIENT_ID"), ClientSecret: clientSecret})
	stop()
	if e != nil {
		slog.Error("OIDC initialization failed; check issuer, TLS trust and client configuration", "error", e)
		os.Exit(1)
	}
	hub := meeting.New(meeting.Config{})
	handler := server.New(server.Config{Auth: manager, Hub: hub, StaticDir: env("STATIC_DIR", "web/dist"), MetricsToken: metricsToken})
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
