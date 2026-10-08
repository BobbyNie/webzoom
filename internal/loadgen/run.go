package loadgen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/coder/websocket"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"webzoom/internal/auth"
	"webzoom/internal/media"
	"webzoom/internal/meeting"
)

type Config struct {
	URL                 string
	Client              *http.Client
	Sessions            []string
	JoinRooms           []string
	Rooms, Viewers, FPS int
	Mbps                float64
	Duration            time.Duration
	Samples             []Sample
	Ready               func([]string)
}
type Result struct {
	Mode              string   `json:"mode"`
	RoomIDs           []string `json:"room_ids"`
	DurationSeconds   float64  `json:"duration_seconds"`
	FramesSent        uint64   `json:"frames_sent"`
	FramesReceived    uint64   `json:"frames_received"`
	BytesReceived     uint64   `json:"bytes_received"`
	SequenceGaps      uint64   `json:"sequence_gaps"`
	Disconnects       uint64   `json:"unexpected_disconnects"`
	ReceiveP95UpperMS int64    `json:"receive_p95_upper_ms"`
	// Network receipt time excludes browser decoding and presentation.
	RenderLatencyVerified bool `json:"render_latency_verified"`
}
type testRoom struct {
	id, cookie, csrf string
	conn             *websocket.Conn
	epoch            uint32
}

func Run(parent context.Context, c Config) (result Result, err error) {
	u, e := url.Parse(c.URL)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return result, errors.New("URL must be an HTTPS origin")
	}
	c.URL = strings.TrimSuffix(c.URL, "/")
	perRoom := c.Viewers + 1
	if len(c.JoinRooms) > 0 {
		perRoom = c.Viewers
		if len(c.JoinRooms) != c.Rooms {
			return result, errors.New("join room count must match -rooms")
		}
		for _, id := range c.JoinRooms {
			if len(id) != 32 || url.PathEscape(id) != id {
				return result, errors.New("invalid room identifier")
			}
		}
	}
	if c.Rooms < 1 || c.Rooms > 5 || c.Viewers < 1 || c.Viewers > 200 || c.FPS < 1 || c.FPS > 30 || c.Mbps <= 0 || c.Mbps > 16 || c.Duration <= 0 || len(c.Sessions) < c.Rooms*perRoom {
		return result, errors.New("invalid load configuration or insufficient sessions")
	}
	if c.Client == nil {
		c.Client = &http.Client{Timeout: 15 * time.Second}
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	var sockets []*websocket.Conn
	var rooms []testRoom
	var wg sync.WaitGroup
	defer func() {
		cancel()
		for _, s := range sockets {
			s.CloseNow()
		}
		wg.Wait()
		for _, r := range rooms {
			cleanup, stop := context.WithTimeout(context.Background(), 3*time.Second)
			_ = api(cleanup, c, r.cookie, r.csrf, "POST", "/api/rooms/"+r.id+"/actions", map[string]string{"action": "end"}, nil)
			stop()
		}
	}()
	var sent, received, bytesRead, gaps, disconnects atomic.Uint64
	var histogram Histogram
	dial := func(cookie, id string) (*websocket.Conn, error) {
		dctx, stop := context.WithTimeout(ctx, 15*time.Second)
		defer stop()
		conn, _, e := websocket.Dial(dctx, "wss"+strings.TrimPrefix(c.URL, "https")+"/api/rooms/"+id+"/ws", &websocket.DialOptions{HTTPClient: c.Client, HTTPHeader: http.Header{"Origin": {c.URL}, "Cookie": {auth.SessionCookie + "=" + cookie}}})
		if e == nil {
			conn.SetReadLimit(media.MaxFrameSize)
			sockets = append(sockets, conn)
		}
		return conn, e
	}
	read := func(conn *websocket.Conn, viewer bool) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var last uint32
			for {
				typ, b, e := conn.Read(ctx)
				if e != nil {
					if ctx.Err() == nil {
						disconnects.Add(1)
					}
					return
				}
				if !viewer || typ != websocket.MessageBinary {
					continue
				}
				f, e := media.Parse(b)
				if e != nil {
					disconnects.Add(1)
					return
				}
				if last > 0 && f.Sequence > last+1 {
					gaps.Add(uint64(f.Sequence - last - 1))
				}
				last = f.Sequence
				received.Add(1)
				bytesRead.Add(uint64(len(b)))
				histogram.Add(time.Now().UnixMilli() - int64(f.Timestamp/1000))
			}
		}()
	}
	for i := 0; i < c.Rooms; i++ {
		if len(c.JoinRooms) > 0 {
			id := c.JoinRooms[i]
			for j := 0; j < c.Viewers; j++ {
				v, e := dial(c.Sessions[i*c.Viewers+j], id)
				if e != nil {
					return result, e
				}
				read(v, true)
			}
			result.RoomIDs = append(result.RoomIDs, id)
			continue
		}
		cookie := c.Sessions[i*(c.Viewers+1)]
		var me struct {
			CSRF string `json:"csrf"`
		}
		if e = api(ctx, c, cookie, "", "GET", "/api/me", nil, &me); e != nil {
			return result, e
		}
		var room meeting.Snapshot
		if e = api(ctx, c, cookie, me.CSRF, "POST", "/api/rooms", map[string]string{}, &room); e != nil {
			return result, e
		}
		rooms = append(rooms, testRoom{id: room.ID, cookie: cookie, csrf: me.CSRF})
		r := &rooms[len(rooms)-1]
		result.RoomIDs = append(result.RoomIDs, r.id)
		r.conn, e = dial(cookie, r.id)
		if e != nil {
			return result, e
		}
		read(r.conn, false)
		for j := 1; j <= c.Viewers; j++ {
			v, e := dial(c.Sessions[i*(c.Viewers+1)+j], r.id)
			if e != nil {
				return result, e
			}
			read(v, true)
		}
		if e = api(ctx, c, cookie, me.CSRF, "POST", "/api/rooms/"+r.id+"/actions", map[string]string{"action": "start"}, &room); e != nil {
			return result, e
		}
		r.epoch = room.Epoch
	}
	result.Mode = "synthetic-relay-only"
	if len(c.Samples) > 0 {
		result.Mode = "vp8-ivf-relay"
	}
	if len(c.JoinRooms) > 0 {
		result.Mode = "existing-room-viewers"
	}
	if c.Ready != nil {
		c.Ready(append([]string(nil), result.RoomIDs...))
	}
	start := time.Now()
	done := time.NewTimer(c.Duration)
	defer done.Stop()
	sample := Sample{Data: make([]byte, int(c.Mbps*1e6/8/float64(c.FPS))), Width: 1920, Height: 1080, Key: true}
	for _, r := range rooms {
		wg.Add(1)
		go func(r testRoom) {
			defer wg.Done()
			ticker := time.NewTicker(time.Second / time.Duration(c.FPS))
			defer ticker.Stop()
			var seq uint32
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					f := sample
					if len(c.Samples) > 0 {
						f = c.Samples[int(seq)%len(c.Samples)]
					}
					seq++
					payload := (media.Frame{Epoch: r.epoch, Sequence: seq, Timestamp: uint64(time.Now().UnixMicro()), Width: f.Width, Height: f.Height, Key: f.Key, Payload: f.Data}).Marshal()
					wctx, stop := context.WithTimeout(ctx, time.Second)
					e := r.conn.Write(wctx, websocket.MessageBinary, payload)
					stop()
					if e != nil {
						if ctx.Err() == nil {
							disconnects.Add(1)
						}
						return
					}
					sent.Add(1)
				}
			}
		}(r)
	}
	select {
	case <-parent.Done():
		err = parent.Err()
	case <-done.C:
	}
	cancel()
	for _, s := range sockets {
		s.CloseNow()
	}
	wg.Wait()
	result.DurationSeconds = time.Since(start).Seconds()
	result.FramesSent = sent.Load()
	result.FramesReceived = received.Load()
	result.BytesReceived = bytesRead.Load()
	result.SequenceGaps = gaps.Load()
	result.Disconnects = disconnects.Load()
	result.ReceiveP95UpperMS = histogram.P95()
	return result, err
}
func api(ctx context.Context, c Config, cookie, csrf, method, path string, body, out any) error {
	var data []byte
	if body != nil {
		var e error
		data, e = json.Marshal(body)
		if e != nil {
			return e
		}
	}
	requestCtx, stop := context.WithTimeout(ctx, 15*time.Second)
	defer stop()
	req, e := http.NewRequestWithContext(requestCtx, method, c.URL+path, bytes.NewReader(data))
	if e != nil {
		return e
	}
	req.AddCookie(&http.Cookie{Name: auth.SessionCookie, Value: cookie})
	req.Header.Set("Origin", c.URL)
	req.Header.Set("X-CSRF-Token", csrf)
	req.Header.Set("Content-Type", "application/json")
	res, e := c.Client.Do(req)
	if e != nil {
		return e
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("%s %s: HTTP %d", method, path, res.StatusCode)
	}
	if out != nil {
		return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(out)
	}
	return nil
}
