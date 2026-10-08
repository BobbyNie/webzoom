package meeting

import (
	"testing"
	"time"
	"webzoom/internal/media"
)

var owner = User{ID: "owner", Name: "Owner"}
var viewer = User{ID: "viewer", Name: "Viewer"}

func setup(t *testing.T) (*Hub, Snapshot, *Peer, *Peer) {
	t.Helper()
	h := New(Config{})
	r, e := h.Create(owner)
	if e != nil {
		t.Fatal(e)
	}
	p, e := h.Join(r.ID, owner, "s1")
	if e != nil {
		t.Fatal(e)
	}
	v, e := h.Join(r.ID, viewer, "s2")
	if e != nil {
		t.Fatal(e)
	}
	return h, r, p, v
}
func frame(epoch uint32, seq uint32, key bool) []byte {
	return (media.Frame{Epoch: epoch, Sequence: seq, Key: key, Width: 1920, Height: 1080, Timestamp: 123, Payload: []byte{1}}).Marshal()
}
func TestOwnerOnlyTransferAndPublishingEpoch(t *testing.T) {
	h, r, p, v := setup(t)
	if _, e := h.Action(r.ID, viewer.ID, "transfer", owner.ID); e == nil {
		t.Fatal("viewer transferred")
	}
	s, e := h.Action(r.ID, owner.ID, "start", "")
	if e != nil {
		t.Fatal(e)
	}
	if e = h.Publish(v, frame(s.Epoch, 1, true)); e == nil {
		t.Fatal("unauthorized publish")
	}
	if e = h.Publish(p, frame(s.Epoch, 1, true)); e != nil {
		t.Fatal(e)
	}
	if v.Media.Len() != 1 {
		t.Fatal("frame not forwarded")
	}
	s2, e := h.Action(r.ID, owner.ID, "transfer", viewer.ID)
	if e != nil || s2.Active || s2.Epoch <= s.Epoch {
		t.Fatal("bad transfer", e)
	}
	if v.Media.Len() != 0 {
		t.Fatal("stale frame queue")
	}
	if e = h.Publish(p, frame(s.Epoch, 2, true)); e == nil {
		t.Fatal("old publisher accepted")
	}
	s3, e := h.Action(r.ID, viewer.ID, "start", "")
	if e != nil {
		t.Fatal(e)
	}
	if e = h.Publish(v, frame(s2.Epoch, 1, true)); e == nil {
		t.Fatal("old epoch accepted")
	}
	if e = h.Publish(v, frame(s3.Epoch, 1, true)); e != nil {
		t.Fatal(e)
	}
	if _, e = h.Action(r.ID, viewer.ID, "end", ""); e == nil {
		t.Fatal("viewer ended room")
	}
	if _, e = h.Action(r.ID, owner.ID, "end", ""); e != nil {
		t.Fatal(e)
	}
	if _, e = h.Get(r.ID); e == nil {
		t.Fatal("ended room exists")
	}
	select {
	case <-p.Done:
	default:
		t.Fatal("owner not disconnected")
	}
}
func TestDisconnectAndExpiry(t *testing.T) {
	now := time.Now()
	h := New(Config{Now: func() time.Time { return now }})
	r, _ := h.Create(owner)
	p, _ := h.Join(r.ID, owner, "s")
	h.Action(r.ID, owner.ID, "start", "")
	h.Leave(p)
	s, _ := h.Get(r.ID)
	if s.Active {
		t.Fatal("disconnect still active")
	}
	now = now.Add(31 * time.Minute)
	h.Sweep()
	if _, e := h.Get(r.ID); e == nil {
		t.Fatal("empty room leaked")
	}
	r, _ = h.Create(owner)
	h.Join(r.ID, owner, "s")
	now = now.Add(9 * time.Hour)
	h.Sweep()
	if _, e := h.Get(r.ID); e == nil {
		t.Fatal("expired room leaked")
	}
}
func TestCapacityAndDuplicateIdentity(t *testing.T) {
	h := New(Config{MaxRooms: 1, MaxViewers: 1})
	r, _ := h.Create(owner)
	if _, e := h.Create(viewer); e == nil {
		t.Fatal("room limit")
	}
	h.Join(r.ID, owner, "s")
	h.Join(r.ID, viewer, "v")
	if _, e := h.Join(r.ID, User{ID: "third"}, "x"); e == nil {
		t.Fatal("viewer limit")
	}
	if _, e := h.Join(r.ID, owner, "s2"); e == nil {
		t.Fatal("duplicate identity")
	}
}
func TestSessionRevocationAndKeyframeCoalescing(t *testing.T) {
	h, r, p, v := setup(t)
	h.Action(r.ID, owner.ID, "start", "")
	for len(p.Events) > 0 {
		<-p.Events
	}
	h.RequestKeyframe(v)
	h.RequestKeyframe(v)
	if len(p.Events) != 1 {
		t.Fatal("keyframe requests not merged")
	}
	h.RevokeSession("s1")
	select {
	case <-p.Done:
	default:
		t.Fatal("revoked connection live")
	}
	s, _ := h.Get(r.ID)
	if s.Active {
		t.Fatal("revoked publisher active")
	}
}
func TestSequenceAndKeyframeGate(t *testing.T) {
	h, r, p, v := setup(t)
	s, _ := h.Action(r.ID, owner.ID, "start", "")
	if e := h.Publish(p, frame(s.Epoch, 1, false)); e != nil {
		t.Fatal(e)
	}
	if v.Media.Len() != 0 {
		t.Fatal("delta before key")
	}
	h.Publish(p, frame(s.Epoch, 2, true))
	if e := h.Publish(p, frame(s.Epoch, 2, false)); e == nil {
		t.Fatal("duplicate sequence")
	}
}

func TestQualityOnlyFromCurrentPublisher(t *testing.T) {
	h, r, p, v := setup(t)
	h.Action(r.ID, owner.ID, "start", "")
	if e := h.ReportQuality(v, 2); e == nil {
		t.Fatal("viewer forged quality")
	}
	if e := h.ReportQuality(p, 5); e == nil {
		t.Fatal("invalid quality")
	}
	if e := h.ReportQuality(p, 2); e != nil {
		t.Fatal(e)
	}
	s, _ := h.Get(r.ID)
	if s.Quality != 2 {
		t.Fatal("quality not in snapshot")
	}
}

func TestSlowViewerDoesNotBlockFastViewer(t *testing.T) {
	h, r, p, slow := setup(t)
	fast, e := h.Join(r.ID, User{ID: "fast"}, "fast-session")
	if e != nil {
		t.Fatal(e)
	}
	s, _ := h.Action(r.ID, owner.ID, "start", "")
	for i := uint32(1); i <= 1000; i++ {
		if e := h.Publish(p, frame(s.Epoch, i, i%30 == 1)); e != nil {
			t.Fatal(e)
		}
		if fast.Media.Len() != 1 {
			t.Fatal("fast viewer stalled")
		}
		fast.Media.Pop()
		if slow.Media.Len() > 8 {
			t.Fatal("slow queue unbounded")
		}
	}
	if h.Metrics.Dropped.Load() == 0 {
		t.Fatal("slow viewer did not drop frames")
	}
}
