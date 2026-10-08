package loadgen_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/loadgen"
	"webzoom/internal/media"
	"webzoom/internal/meeting"
	"webzoom/internal/server"
)

func TestRunUsesAuthenticatedWSSAndReceivesFrames(t *testing.T) {
	ts := httptest.NewUnstartedServer(nil)
	origin := "https://" + ts.Listener.Addr().String()
	a := auth.NewStore(origin)
	h := meeting.New(meeting.Config{})
	ts.Config.Handler = server.New(server.Config{Auth: a, Hub: h})
	ts.StartTLS()
	defer ts.Close()
	var sessions []string
	for i := 0; i < 3; i++ {
		s, e := a.NewSession(meeting.User{ID: fmt.Sprint(i)}, time.Now().Add(time.Minute))
		if e != nil {
			t.Fatal(e)
		}
		sessions = append(sessions, s.ID)
	}
	c := loadgen.Config{URL: origin, Client: ts.Client(), Sessions: sessions, Rooms: 1, Viewers: 2, FPS: 30, Mbps: 1, Duration: 300 * time.Millisecond}
	result, e := loadgen.Run(context.Background(), c)
	if e != nil {
		t.Fatal(e)
	}
	if result.FramesReceived < 8 || result.BytesReceived == 0 || result.Disconnects != 0 || len(result.RoomIDs) != 1 || result.Mode != "synthetic-relay-only" {
		t.Fatalf("%+v", result)
	}
	c.Sessions = []string{"invalid", "invalid", "invalid"}
	if _, e = loadgen.Run(context.Background(), c); e == nil {
		t.Fatal("accepted invalid session")
	}
	c.URL = "http://localhost"
	if _, e = loadgen.Run(context.Background(), c); e == nil {
		t.Fatal("accepted plaintext")
	}
}

// Opt-in loopback experiment. This is not the 30-minute browser acceptance test.
func TestCapacitySmoke(t *testing.T) {
	if os.Getenv("WEBZOOM_LOAD_SMOKE") != "1" {
		t.Skip("set WEBZOOM_LOAD_SMOKE=1 for the 10-second 1000-viewer loopback experiment")
	}
	ts := httptest.NewUnstartedServer(nil)
	origin := "https://" + ts.Listener.Addr().String()
	a := auth.NewStore(origin)
	h := meeting.New(meeting.Config{})
	ts.Config.Handler = server.New(server.Config{Auth: a, Hub: h})
	ts.StartTLS()
	defer ts.Close()
	var sessions []string
	for i := 0; i < 1005; i++ {
		s, e := a.NewSession(meeting.User{ID: fmt.Sprint(i)}, time.Now().Add(5*time.Minute))
		if e != nil {
			t.Fatal(e)
		}
		sessions = append(sessions, s.ID)
	}
	result, e := loadgen.Run(context.Background(), loadgen.Config{URL: origin, Client: ts.Client(), Sessions: sessions, Rooms: 5, Viewers: 200, FPS: 30, Mbps: 6, Duration: 10 * time.Second})
	b, _ := json.Marshal(result)
	t.Log(string(b))
	t.Logf("server dropped frames: %d", h.Metrics.Dropped.Load())
	if e != nil {
		t.Fatal(e)
	}
	if result.FramesReceived == 0 || result.Disconnects != 0 {
		t.Fatal("relay experiment failed")
	}
}

func TestWatchExistingBrowserMeetingDoesNotEndIt(t *testing.T) {
	ts := httptest.NewUnstartedServer(nil)
	origin := "https://" + ts.Listener.Addr().String()
	a := auth.NewStore(origin)
	h := meeting.New(meeting.Config{})
	ts.Config.Handler = server.New(server.Config{Auth: a, Hub: h})
	ts.StartTLS()
	defer ts.Close()
	owner := meeting.User{ID: "browser-owner"}
	r, _ := h.Create(owner)
	p, _ := h.Join(r.ID, owner, "browser")
	state, _ := h.Action(r.ID, owner.ID, "start", "")
	s, _ := a.NewSession(meeting.User{ID: "load-viewer"}, time.Now().Add(time.Minute))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ready := func(_ []string) {
		go func() {
			tick := time.NewTicker(time.Second / 30)
			defer tick.Stop()
			var seq uint32
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					seq++
					h.Publish(p, (media.Frame{Epoch: state.Epoch, Sequence: seq, Key: true, Width: 1920, Height: 1080, Timestamp: uint64(time.Now().UnixMicro()), Payload: []byte{0}}).Marshal())
				}
			}
		}()
	}
	result, e := loadgen.Run(ctx, loadgen.Config{URL: origin, Client: ts.Client(), Sessions: []string{s.ID}, Rooms: 1, Viewers: 1, FPS: 30, Mbps: 1, Duration: 200 * time.Millisecond, JoinRooms: []string{r.ID}, Ready: ready})
	if e != nil {
		t.Fatal(e)
	}
	if result.FramesSent != 0 || result.FramesReceived == 0 || result.Mode != "existing-room-viewers" {
		t.Fatalf("%+v", result)
	}
	if _, e = h.Get(r.ID); e != nil {
		t.Fatal("watcher ended a browser-owned room")
	}
}
