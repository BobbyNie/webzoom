// loadtest opens only authenticated HTTPS/WSS connections. It does not measure rendering.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
	"webzoom/internal/loadgen"
)

func main() {
	if e := run(os.Args[1:], os.Stdout); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("loadtest", flag.ContinueOnError)
	var c loadgen.Config
	var sessionFile, caFile, ivf, joinRooms string
	fs.StringVar(&c.URL, "url", "", "public HTTPS origin")
	fs.StringVar(&sessionFile, "sessions", "", "0600 JSON file containing an array of session cookie values")
	fs.StringVar(&caFile, "ca", "", "additional PEM CA bundle; certificate verification remains enabled")
	fs.StringVar(&joinRooms, "join-rooms", "", "comma-separated existing room IDs; viewers only, no room creation or closure")
	fs.StringVar(&ivf, "ivf", "", "VP8 IVF file; absent means synthetic, non-decodable frames")
	fs.IntVar(&c.Rooms, "rooms", 5, "rooms (1..5)")
	fs.IntVar(&c.Viewers, "viewers", 200, "viewers per room (1..200)")
	fs.IntVar(&c.FPS, "fps", 30, "frames per second (1..30)")
	fs.Float64Var(&c.Mbps, "mbps", 6, "synthetic bitrate per publisher; ignored for IVF")
	fs.DurationVar(&c.Duration, "duration", 30*time.Minute, "steady-state duration after setup")
	if e := fs.Parse(args); e != nil {
		return e
	}
	if joinRooms != "" {
		c.JoinRooms = strings.Split(joinRooms, ",")
	}
	if sessionFile == "" {
		return errors.New("-sessions is required; never put credentials on the command line")
	}
	info, e := os.Stat(sessionFile)
	if e != nil {
		return e
	}
	if info.Mode().Perm()&0077 != 0 {
		return errors.New("session file must have permissions 0600")
	}
	f, e := os.Open(sessionFile)
	if e != nil {
		return e
	}
	e = json.NewDecoder(io.LimitReader(f, 2<<20)).Decode(&c.Sessions)
	f.Close()
	if e != nil {
		return e
	}
	roots, e := x509.SystemCertPool()
	if e != nil {
		roots = x509.NewCertPool()
	}
	if caFile != "" {
		b, e := os.ReadFile(caFile)
		if e != nil {
			return e
		}
		if !roots.AppendCertsFromPEM(b) {
			return errors.New("no certificates in CA bundle")
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	c.Client = &http.Client{Transport: transport, Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	if ivf != "" {
		f, e := os.Open(ivf)
		if e != nil {
			return e
		}
		c.Samples, e = loadgen.ReadIVF(f)
		f.Close()
		if e != nil {
			return e
		}
	}
	c.Ready = func(ids []string) {
		for _, id := range ids {
			fmt.Fprintln(os.Stderr, "sample room:", c.URL+"/m/"+id)
		}
		fmt.Fprintln(os.Stderr, "All viewers connected. Network-only measurement started; real browser sampling is still required.")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	result, err := loadgen.Run(ctx, c)
	if e = json.NewEncoder(out).Encode(result); e != nil {
		return e
	}
	if err != nil {
		return err
	}
	if result.Disconnects > 0 || result.FramesReceived == 0 {
		return errors.New("relay test failed: disconnected or no received frames")
	}
	return nil
}
