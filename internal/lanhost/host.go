// Package lanhost is a per-Chrome-port, per-meeting native messaging host.
package lanhost

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"
	"webzoom/internal/lan"
	"webzoom/internal/media"
	"webzoom/internal/meeting"
)

type Policy struct {
	Origin      string `json:"origin"`
	ExtensionID string `json:"extensionId"`
	InterfaceIP string `json:"interfaceIP"`
	Port        int    `json:"port"`
	MaxMbps     int    `json:"maxMbps"`
}

func (p Policy) Validate(caller string) error {
	u, e := url.Parse(p.Origin)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return lan.ErrInvalid
	}
	if strings.TrimRight(p.Origin, "/") != p.Origin {
		return lan.ErrInvalid
	}
	if len(p.ExtensionID) != 32 || strings.Trim(p.ExtensionID, "abcdefghijklmnop") != "" || caller != "chrome-extension://"+p.ExtensionID+"/" {
		return lan.ErrInvalid
	}
	if net.ParseIP(p.InterfaceIP).To4() == nil || p.Port < 1024 || p.Port > 65535 || p.MaxMbps < 1 || p.MaxMbps > 8 {
		return lan.ErrInvalid
	}
	return nil
}

// Pilot deliberately rejects multi-adapter IPv4 systems: wildcard reception otherwise
// needs platform packet-info validation to distinguish overlapping corporate/VPN subnets.
func ApprovedNetwork(ip string) (*net.IPNet, error) {
	ifs, e := net.Interfaces()
	if e != nil {
		return nil, e
	}
	var chosen *net.IPNet
	count := 0
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 || i.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, e := i.Addrs()
		if e != nil {
			return nil, e
		}
		for _, a := range addresses {
			n, ok := a.(*net.IPNet)
			if !ok || n.IP.To4() == nil {
				continue
			}
			count++
			if n.IP.String() == ip && i.Flags&net.FlagBroadcast != 0 {
				ones, bits := n.Mask.Size()
				if bits == 32 && ones >= 16 && ones <= 30 {
					chosen = n
				}
			}
		}
	}
	if chosen == nil || count != 1 {
		return nil, errors.New("select one approved IPv4 adapter; multi-adapter/VPN pilot is unsupported")
	}
	return chosen, nil
}
func Broadcast(n *net.IPNet) net.IP {
	ip := n.IP.To4()
	out := make(net.IP, 4)
	for i := range out {
		out[i] = ip[i] | ^n.Mask[i]
	}
	return out
}

type command struct {
	Type     string            `json:"type"`
	Origin   string            `json:"origin"`
	Protocol int               `json:"protocol"`
	State    *meeting.LANState `json:"state"`
	lan.Chunk
}
type probe struct {
	Type  string `json:"type"`
	Room  string `json:"room"`
	Node  string `json:"node"`
	Token string `json:"token"`
}
type nativeFrame struct {
	data       []byte
	generation string
}
type Host struct {
	policy           Policy
	network          *net.IPNet
	conn             *net.UDPConn
	dest             *net.UDPAddr
	mu               sync.Mutex
	state            meeting.LANState
	codec            *lan.Codec
	pub              []byte
	room, generation lan.ID
	lease            time.Time
	cancel           context.CancelFunc
	output           chan any
	frames           chan nativeFrame
	relay            chan []byte
	ack              chan lan.Chunk
	ctx              context.Context
	stop             context.CancelFunc
	started          bool
	lastProbe        time.Time
	lastSeq          uint32
	hasSeq           bool
}

func Run(ctx context.Context, p Policy, in io.Reader, out io.Writer) error {
	network, e := ApprovedNetwork(p.InterfaceIP)
	if e != nil {
		return e
	}
	conn, e := listenUDP(p.Port)
	if e != nil {
		return fmt.Errorf("approved UDP port unavailable: %w", e)
	}
	defer conn.Close()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	h := &Host{policy: p, network: network, conn: conn, dest: &net.UDPAddr{IP: Broadcast(network), Port: p.Port}, output: make(chan any, 32), frames: make(chan nativeFrame, 1), relay: make(chan []byte, 1), ack: make(chan lan.Chunk, 1), ctx: ctx, stop: cancel}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case v := <-h.output:
				if lan.WriteMessage(out, v) != nil {
					cancel()
					return
				}
			}
		}
	}()
	go h.receive()
	go h.sendFrames()
	go h.sendUDP()
	go h.watch()
	commands := make(chan command)
	readError := make(chan error, 1)
	go func() {
		defer close(commands)
		for {
			var c command
			if e := lan.ReadMessage(in, &c); e != nil {
				readError <- e
				return
			}
			select {
			case commands <- c:
			case <-ctx.Done():
				return
			}
		}
	}()
	var chunks lan.Chunks
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case c, ok := <-commands:
			if !ok {
				return <-readError
			}
			if !h.started {
				if c.Type != "start" || c.Origin != p.Origin || c.Protocol != 1 {
					return lan.ErrInvalid
				}
				h.started = true
				h.emit(map[string]any{"type": "started", "protocol": 1})
				continue
			}
			switch c.Type {
			case "configure":
				if c.State == nil {
					return lan.ErrInvalid
				}
				if e := h.configure(*c.State); e != nil {
					return e
				}
			case "probe":
				if c.State == nil {
					return lan.ErrInvalid
				}
				h.probe(*c.State)
			case "chunk":
				c.Chunk.Type = "chunk"
				b, e := chunks.Add(c.Chunk, time.Now())
				if e != nil {
					return e
				}
				h.emit(map[string]any{"type": "ack", "id": c.ID, "index": c.Index})
				if b != nil {
					select {
					case h.relay <- b:
					default:
						h.emit(map[string]any{"type": "keyframe"})
					}
				}
			case "ack":
				select {
				case h.ack <- c.Chunk:
				default:
				}
			case "stop":
				return nil
			default:
				return lan.ErrInvalid
			}
		}
	}
}
func (h *Host) emit(v any) bool {
	select {
	case <-h.ctx.Done():
		return false
	case h.output <- v:
		return true
	default:
		return false
	}
}
func (h *Host) configure(s meeting.LANState) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	now := time.Now()
	if s.LeaseMS < 1000 || s.LeaseMS > 4000 {
		return lan.ErrInvalid
	}
	if _, e := lan.ParseID(s.Node); e != nil {
		return e
	}
	room, e := lan.ParseID(s.Room)
	if e != nil {
		return e
	}
	generation, e := lan.ParseID(s.Generation)
	if e != nil {
		return e
	}
	if h.state.Generation == s.Generation {
		if h.state.Role != s.Role || h.state.Key != s.Key || h.state.Group != s.Group || h.state.Room != s.Room || h.state.Node != s.Node || h.state.Public != s.Public || h.state.Epoch != s.Epoch || !now.Before(h.lease) {
			return lan.ErrInvalid
		}
		h.lease = now.Add(time.Duration(s.LeaseMS) * time.Millisecond)
		return nil
	}
	if h.cancel != nil {
		h.cancel()
	}
	h.codec = nil
	h.hasSeq = false
	h.state = s
	h.room = room
	h.generation = generation
	h.lease = now.Add(time.Duration(s.LeaseMS) * time.Millisecond)
	switch s.Role {
	case "relay", "receiver":
		key, e := base64.StdEncoding.DecodeString(s.Key)
		if e != nil {
			return e
		}
		group, e := lan.ParseID(s.Group)
		if e != nil {
			return e
		}
		h.codec, e = lan.NewCodec(key, group, generation)
		if e != nil {
			return e
		}
		h.pub, e = base64.StdEncoding.DecodeString(s.Public)
		if e != nil || len(h.pub) != 65 {
			return lan.ErrInvalid
		}
	case "probing", "publisher", "unavailable":
	default:
		return lan.ErrInvalid
	}
	h.emit(map[string]any{"type": "configured", "generation": s.Generation, "role": s.Role})
	return nil
}
func (h *Host) probe(s meeting.LANState) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s.Room != h.state.Room || s.Node != h.state.Node || len(s.Token) != 32 || time.Since(h.lastProbe) < time.Second {
		return
	}
	h.lastProbe = time.Now()
	b, _ := json.Marshal(probe{Type: "WZP1", Room: s.Room, Node: s.Node, Token: s.Token})
	h.conn.WriteToUDP(b, h.dest)
}
func allowProbeReport(reported map[string]time.Time, node string, now time.Time) bool {
	if len(reported) >= 256 {
		for k, at := range reported {
			if now.Sub(at) > 5*time.Second {
				delete(reported, k)
			}
		}
	}
	if len(reported) >= 256 || now.Sub(reported[node]) < time.Second {
		return false
	}
	reported[node] = now
	return true
}

func (h *Host) receive() {
	b := make([]byte, lan.DatagramSize+1)
	window := time.Now()
	packets := 0
	reports := 0
	reported := map[string]time.Time{}
	for {
		n, src, e := h.conn.ReadFromUDP(b)
		if e != nil {
			return
		}
		now := time.Now()
		if now.Sub(window) >= time.Second {
			window = now
			packets = 0
			reports = 0
		}
		packets++
		if packets > 5000 || src.Port != h.policy.Port || !h.network.Contains(src.IP) || n > lan.DatagramSize {
			continue
		}
		h.mu.Lock()
		if !now.Before(h.lease) {
			h.mu.Unlock()
			continue
		}
		if n <= 512 && n > 0 && b[0] == '{' {
			var p probe
			if json.Unmarshal(b[:n], &p) == nil && p.Type == "WZP1" && p.Room == h.state.Room && p.Node != h.state.Node && len(p.Node) == 32 && len(p.Token) == 32 {
				// Bound proof reports below the authenticated WSS control rate limit.
				if reports < 4 && allowProbeReport(reported, p.Node, now) {
					reports++
					h.emit(map[string]any{"type": "seen", "node": p.Node, "token": p.Token})
				}
			}
			h.mu.Unlock()
			continue
		}
		if h.state.Role != "receiver" || h.codec == nil {
			h.mu.Unlock()
			continue
		}
		envelope, e := h.codec.Decode(b[:n], now)
		if e == nil && envelope != nil {
			raw, e := lan.Verify(h.pub, h.room, h.generation, envelope)
			if e == nil {
				f, _ := media.Parse(raw)
				if f.Epoch == h.state.Epoch && (!h.hasSeq || f.Sequence > h.lastSeq) {
					// The signed sequence, not the shared-key UDP header, is authoritative.
					h.hasSeq = true
					h.lastSeq = f.Sequence
					h.codec.Accept(f.Sequence)
					h.deliver(raw)
				}
			}
		}
		h.mu.Unlock()
	}
}
func (h *Host) deliver(raw []byte) {
	select {
	case h.frames <- nativeFrame{data: raw, generation: h.state.Generation}:
	default:
		h.emit(map[string]any{"type": "keyframe"})
	}
}
func (h *Host) sendFrames() {
	serial := uint64(0)
	for {
		select {
		case <-h.ctx.Done():
			return
		case frame := <-h.frames:
			raw := frame.data
			serial++
			id := frame.generation + "-" + fmt.Sprint(serial)
			count := (len(raw) + lan.IPCChunk - 1) / lan.IPCChunk
			for i := 0; i < count; i++ {
				end := (i + 1) * lan.IPCChunk
				if end > len(raw) {
					end = len(raw)
				}
				if !h.emit(lan.Chunk{Type: "chunk", ID: id, Index: i, Count: count, Data: base64.StdEncoding.EncodeToString(raw[i*lan.IPCChunk : end])}) {
					break
				}
				timer := time.NewTimer(time.Second)
				acked := false
			wait:
				for {
					select {
					case <-h.ctx.Done():
						timer.Stop()
						return
					case a := <-h.ack:
						if a.ID == id && a.Index == i {
							acked = true
							break wait
						}
					case <-timer.C:
						break wait
					}
				}
				timer.Stop()
				if !acked {
					h.emit(map[string]any{"type": "keyframe"})
					break
				}
			}
		}
	}
}
func (h *Host) sendUDP() {
	pacer := lan.Pacer{Mbps: h.policy.MaxMbps}
	for {
		select {
		case <-h.ctx.Done():
			return
		case b := <-h.relay:
			h.mu.Lock()
			if h.state.Role != "relay" || h.codec == nil || !time.Now().Before(h.lease) {
				h.mu.Unlock()
				continue
			}
			raw, e := lan.Verify(h.pub, h.room, h.generation, b)
			if e != nil {
				h.mu.Unlock()
				continue
			}
			f, _ := media.Parse(raw)
			if f.Epoch != h.state.Epoch || (h.hasSeq && f.Sequence <= h.lastSeq) {
				h.mu.Unlock()
				continue
			}
			h.lastSeq = f.Sequence
			h.hasSeq = true
			packets, e := h.codec.Encode(f.Sequence, b)
			ctx, cancel := context.WithCancel(h.ctx)
			h.cancel = cancel
			h.deliver(raw)
			h.mu.Unlock()
			if e != nil {
				cancel()
				continue
			}
		sending:
			for _, packet := range packets {
				h.mu.Lock()
				valid := time.Now().Before(h.lease)
				h.mu.Unlock()
				if !valid {
					break
				}
				select {
				case <-ctx.Done():
					break sending
				default:
				}
				delay := pacer.Delay(len(packet)+28, time.Now())
				if delay > 0 {
					timer := time.NewTimer(delay)
					select {
					case <-ctx.Done():
						timer.Stop()
						break sending
					case <-timer.C:
					}
				}
				if _, e = h.conn.WriteToUDP(packet, h.dest); e != nil {
					h.emit(map[string]any{"type": "error", "message": "UDP send failed"})
					break
				}

			}
			cancel()
		}
	}
}
func (h *Host) watch() {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-h.ctx.Done():
			return
		case <-t.C:
			// An adapter/VPN/address change invalidates this process; never silently reroute.
			network, err := ApprovedNetwork(h.policy.InterfaceIP)
			if err != nil || !network.IP.Equal(h.network.IP) || network.Mask.String() != h.network.Mask.String() {
				h.emit(map[string]any{"type": "error", "message": "Approved adapter changed; reconnect required"})
				h.stop()
				return
			}
			h.mu.Lock()
			expired := !h.lease.IsZero() && !time.Now().Before(h.lease)
			h.mu.Unlock()
			if expired {
				h.emit(map[string]any{"type": "error", "message": "LAN authorization lease expired; reconnect required"})
			} else {
				h.emit(map[string]any{"type": "heartbeat"})
			}
		}
	}
}
