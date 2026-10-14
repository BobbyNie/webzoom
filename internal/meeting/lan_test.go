package meeting

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"testing"
	"time"
	"webzoom/internal/lan"
	"webzoom/internal/media"
)

func drainLAN(h *Hub) {
	for _, r := range h.rooms {
		for _, p := range r.peers {
			for len(p.Events) > 0 {
				<-p.Events
			}
		}
	}
}
func readyLAN(t *testing.T, h *Hub, p *Peer) {
	t.Helper()
	if e := h.LANControl(p, LANCommand{Op: "ready"}); e != nil {
		t.Fatal(e)
	}
	drainLAN(h)
}
func ackLAN(t *testing.T, h *Hub) {
	t.Helper()
	for _, r := range h.rooms {
		for _, p := range r.peers {
			if p.lan != nil {
				if e := h.LANControl(p, LANCommand{Op: "configured", Generation: p.lan.state.Generation}); e != nil {
					t.Fatal(e)
				}
			}
		}
	}
	drainLAN(h)
}
func TestLANSingleFanoutRealProofAndRotation(t *testing.T) {
	now := time.Now()
	h := New(Config{Now: func() time.Time { return now }, LAN: LANConfig{Enabled: true}})
	r, _ := h.Create(owner)
	pub, _ := h.Join(r.ID, owner, "pub")
	a, _ := h.JoinLAN(r.ID, User{ID: "a"}, "a")
	b, _ := h.JoinLAN(r.ID, User{ID: "b"}, "b")
	readyLAN(t, h, a)
	readyLAN(t, h, b)
	if a.lan.state.Role != "relay" || b.lan.state.Role != "relay" {
		t.Fatal("unproven groups merged")
	}
	h.lanProbe(h.rooms[r.ID], a, now)
	h.LANControl(b, LANCommand{Op: "seen", Node: a.lan.node.String(), Token: "forged"})
	if b.lan.state.Role == "receiver" {
		t.Fatal("forged proof")
	}
	h.LANControl(b, LANCommand{Op: "seen", Node: a.lan.node.String(), Token: a.lan.challenge})
	if a.lan.state.Role != "relay" || b.lan.state.Role != "receiver" {
		t.Fatal("proven group not formed")
	}
	s, _ := h.Action(r.ID, owner.ID, "start", "")
	ackLAN(t, h)
	raw := frame(s.Epoch, 1, true)
	if e := h.Publish(pub, raw); e != nil {
		t.Fatal(e)
	}
	signed, ok := a.Media.Pop()
	if !ok || b.Media.Len() != 0 {
		t.Fatal("not exactly one group feed")
	}
	public, _ := base64.StdEncoding.DecodeString(a.lan.state.Public)
	got, e := lan.Verify(public, h.rooms[r.ID].lan.tag, h.rooms[r.ID].lan.generation, signed)
	if e != nil || !bytes.Equal(got, raw) {
		t.Fatal("signed feed", e)
	}
	oldKey := a.lan.state.Key
	oldGen := a.lan.state.Generation
	h.Leave(b)
	if a.lan.state.Key == oldKey || a.lan.state.Generation == oldGen {
		t.Fatal("leave did not revoke key")
	}
	if a.Media.Len() != 0 {
		t.Fatal("old queue retained")
	}
	if e := h.LANControl(b, LANCommand{Op: "heartbeat"}); e == nil {
		t.Fatal("departed control")
	}
}
func TestLANBudgetNoFallbackAndLeaseFailure(t *testing.T) {
	now := time.Now()
	h := New(Config{Now: func() time.Time { return now }, LAN: LANConfig{Enabled: true, BudgetMbps: 8}})
	r, _ := h.Create(owner)
	h.Join(r.ID, owner, "pub")
	a, _ := h.JoinLAN(r.ID, User{ID: "a"}, "a")
	readyLAN(t, h, a)
	b, _ := h.JoinLAN(r.ID, User{ID: "b"}, "b")
	readyLAN(t, h, b)
	if h.lanUsed() != 1 {
		t.Fatal("reservation overflow")
	}
	if _, e := h.Join(r.ID, User{ID: "legacy"}, "l"); e != ErrBandwidth {
		t.Fatal("unbudgeted legacy fallback", e)
	}
	var relay, blocked *Peer
	if a.lan.state.Role == "relay" {
		relay, blocked = a, b
	} else {
		relay, blocked = b, a
	}
	if blocked.lan.state.Role != "unavailable" {
		t.Fatal("expected explicit unavailable")
	}
	now = now.Add(7 * time.Second)
	h.LANControl(blocked, LANCommand{Op: "heartbeat"})
	h.LANTick()
	drainLAN(h)
	if relay.lan.state.Role != "probing" || blocked.lan.state.Role != "relay" {
		t.Fatal("no lease failover", relay.lan.state.Role, blocked.lan.state.Role)
	}
}
func TestLANManyReceiversOneStreamAndControlsRetained(t *testing.T) {
	now := time.Now()
	h := New(Config{Now: func() time.Time { return now }, LAN: LANConfig{Enabled: true}})
	r, _ := h.Create(owner)
	pub, _ := h.Join(r.ID, owner, "pub")
	relay, _ := h.JoinLAN(r.ID, User{ID: "relay"}, "relay")
	readyLAN(t, h, relay)
	for i := 0; i < 50; i++ {
		p, _ := h.JoinLAN(r.ID, User{ID: fmt.Sprint(i)}, fmt.Sprint(i))
		readyLAN(t, h, p)
		h.lanProbe(h.rooms[r.ID], relay, now)
		h.LANControl(p, LANCommand{Op: "seen", Node: relay.lan.node.String(), Token: relay.lan.challenge})
		drainLAN(h)
	}
	if h.lanUsed() != 1 {
		t.Fatal("stream count depends on viewers")
	}
	s, _ := h.Action(r.ID, owner.ID, "start", "")
	ackLAN(t, h)
	if e := h.Publish(pub, frame(s.Epoch, 1, true)); e != nil {
		t.Fatal(e)
	}
	_, connections, queued := h.Counts()
	if connections != 52 || queued != 1 {
		t.Fatal(connections, queued)
	}
	if _, e := h.Action(r.ID, "1", "annotation-request", ""); e != nil {
		t.Fatal("control lost", e)
	}
}
func TestLANPublisherTransferRekeysAndRejectsOldPublisher(t *testing.T) {
	h := New(Config{LAN: LANConfig{Enabled: true}})
	r, _ := h.Create(owner)
	pub, _ := h.Join(r.ID, owner, "p")
	v, _ := h.JoinLAN(r.ID, viewer, "v")
	readyLAN(t, h, v)
	s, _ := h.Action(r.ID, owner.ID, "start", "")
	gen := v.lan.state.Generation
	_, e := h.Action(r.ID, owner.ID, "transfer", viewer.ID)
	if e != nil || v.lan.state.Role != "publisher" || v.lan.state.Generation == gen {
		t.Fatal("transfer", e)
	}
	if h.Publish(pub, frame(s.Epoch, 1, true)) == nil {
		t.Fatal("old publisher")
	}
}
func TestLANDisabledAndBudgetPacing(t *testing.T) {
	h, r, _, _ := setup(t)
	if _, e := h.JoinLAN(r.ID, User{ID: "x"}, "x"); e != ErrForbidden {
		t.Fatal(e)
	}
	h = New(Config{LAN: LANConfig{Enabled: true, BudgetMbps: 8}})
	now := time.Now()
	if !h.lanSpend(1000000, now) || h.lanSpend(1, now) || !h.lanSpend(1000000, now.Add(time.Second)) {
		t.Fatal("egress token bucket")
	}
}
func TestLANWholeMediaPathWithoutOfficeNetwork(t *testing.T) {
	h := New(Config{LAN: LANConfig{Enabled: true}})
	r, _ := h.Create(owner)
	pub, _ := h.Join(r.ID, owner, "p")
	relay, _ := h.JoinLAN(r.ID, viewer, "v")
	readyLAN(t, h, relay)
	s, _ := h.Action(r.ID, owner.ID, "start", "")
	ackLAN(t, h)
	raw := (media.Frame{Epoch: s.Epoch, Sequence: 1, Key: true, Width: 1280, Height: 720, Payload: bytes.Repeat([]byte{8}, 80000)}).Marshal()
	h.Publish(pub, raw)
	signed, _ := relay.Media.Pop()
	state := relay.lan.state
	key, _ := base64.StdEncoding.DecodeString(state.Key)
	public, _ := base64.StdEncoding.DecodeString(state.Public)
	group, _ := lan.ParseID(state.Group)
	generation, _ := lan.ParseID(state.Generation)
	room, _ := lan.ParseID(state.Room)
	tx, _ := lan.NewCodec(key, group, generation)
	rx, _ := lan.NewCodec(key, group, generation)
	packets, _ := tx.Encode(1, signed)
	var result []byte
	for _, packet := range packets {
		b, e := rx.Decode(packet, time.Now())
		if e != nil {
			t.Fatal(e)
		}
		if b != nil {
			result, e = lan.Verify(public, room, generation, b)
			if e != nil {
				t.Fatal(e)
			}
		}
	}
	if !bytes.Equal(result, raw) {
		t.Fatal("media path changed payload")
	}
}

func TestLANTransferCannotOversubscribeLegacyReservations(t *testing.T) {
	h := New(Config{LAN: LANConfig{Enabled: true, BudgetMbps: 8}})
	r, _ := h.Create(owner)
	h.Join(r.ID, owner, "owner")
	h.Join(r.ID, User{ID: "legacy"}, "legacy")
	p, _ := h.JoinLAN(r.ID, User{ID: "lan"}, "lan")
	readyLAN(t, h, p)
	before := h.rooms[r.ID].Epoch
	if _, err := h.Action(r.ID, owner.ID, "transfer", "lan"); err != ErrBandwidth {
		t.Fatal("unreserved direct stream admitted", err)
	}
	if h.rooms[r.ID].PublisherID != owner.ID || h.rooms[r.ID].Epoch != before {
		t.Fatal("rejected transfer changed meeting")
	}
}
