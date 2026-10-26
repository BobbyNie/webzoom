package server

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"strings"
	"testing"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/media"
	"webzoom/internal/meeting"
)

func TestMediaWindowBoundsAndValidatesCredits(t *testing.T) {
	w := newMediaWindow()
	for range mediaWindowSize {
		if !w.available() {
			t.Fatal("early backpressure")
		}
		w.reserve()
	}
	if w.available() {
		t.Fatal("unbounded browser buffering")
	}
	for _, sequence := range []uint64{0, 99} {
		if ok, _ := w.acknowledge(sequence); ok {
			t.Fatal("invalid credit accepted")
		}
	}
	if w.available() {
		t.Fatal("invalid credit expanded window")
	}
	w.lastAck = time.Now().Add(-2 * time.Second)
	if ok, stalled := w.acknowledge(1); !ok || !stalled {
		t.Fatal("resume not detected")
	}
	if !w.available() {
		t.Fatal("credit did not resume media")
	}
	w.reserve()
	if w.available() {
		t.Fatal("credit granted more than one slot")
	}
	if ok, _ := w.acknowledge(1); ok {
		t.Fatal("duplicate credit accepted")
	}
	if ok, _ := w.acknowledge(4); !ok {
		t.Fatal("cumulative acknowledgement rejected")
	}
	if !w.available() {
		t.Fatal("cumulative credit did not resume media")
	}
}

func TestMediaWindowDoesNotBlockControlOrGrowWithoutAck(t *testing.T) {
	ts, a, h := testApp(t)
	owner := meeting.User{ID: "owner"}
	room, _ := h.Create(owner)
	publisher, _ := h.Join(room.ID, owner, "owner-session")
	session, _ := a.NewSession(meeting.User{ID: "viewer"}, time.Now().Add(time.Hour))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "wss"+strings.TrimPrefix(ts.URL, "https")+"/api/rooms/"+room.ID+"/ws?mediaAck=1", &websocket.DialOptions{HTTPClient: ts.Client(), HTTPHeader: http.Header{"Origin": []string{ts.URL}, "Cookie": []string{auth.SessionCookie + "=" + session.ID}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	snapshot, err := h.Action(room.ID, owner.ID, "start", "")
	if err != nil {
		t.Fatal(err)
	}
	for sequence := uint32(1); sequence <= mediaWindowSize; sequence++ {
		b := (media.Frame{Epoch: snapshot.Epoch, Sequence: sequence, Key: true, Width: 640, Height: 360, Payload: []byte{1}}).Marshal()
		if err = h.Publish(publisher, b); err != nil {
			t.Fatal(err)
		}
		for {
			typ, _, err := conn.Read(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if typ == websocket.MessageBinary {
				break
			}
		}
	}
	// Fill the hub queue while the browser has supplied no media credits.
	for sequence := uint32(5); sequence <= 100; sequence++ {
		b := (media.Frame{Epoch: snapshot.Epoch, Sequence: sequence, Key: true, Width: 640, Height: 360, Payload: []byte{1}}).Marshal()
		if err = h.Publish(publisher, b); err != nil {
			t.Fatal(err)
		}
	}
	if err = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"clock","clientTime":123}`)); err != nil {
		t.Fatal(err)
	}
	for {
		typ, raw, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if typ == websocket.MessageBinary {
			t.Fatal("media escaped full window")
		}
		var message struct {
			Type string `json:"type"`
		}
		json.Unmarshal(raw, &message)
		if message.Type == "clock" {
			break
		}
	}
	if err = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"media-ack","sequence":4}`)); err != nil {
		t.Fatal(err)
	}
	for {
		typ, _, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if typ == websocket.MessageBinary {
			break
		}
	}
}
