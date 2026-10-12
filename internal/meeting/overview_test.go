package meeting

import (
	"testing"
	"time"
)

func TestOverviewLifecycleAndTraffic(t *testing.T) {
	h, r, p, v := setup(t)
	empty := h.Overview()
	if len(empty.Rooms) != 1 || empty.Rooms[0].Participants != 2 || empty.IngressBytes != 0 {
		t.Fatalf("unexpected overview: %+v", empty)
	}
	s, _ := h.Action(r.ID, owner.ID, "start", "")
	b := frame(s.Epoch, 1, true)
	if err := h.Publish(v, b); err == nil {
		t.Fatal("viewer accepted")
	}
	if h.Overview().IngressBytes != 0 {
		t.Fatal("rejected media counted")
	}
	if err := h.Publish(p, b); err != nil {
		t.Fatal(err)
	}
	h.RecordEgress(v, len(b))
	o := h.Overview()
	if o.IngressBytes != uint64(len(b)) || o.EgressBytes != uint64(len(b)) || o.Rooms[0].IngressBytes != o.IngressBytes || o.Rooms[0].EgressBytes != o.EgressBytes || !o.Rooms[0].Active {
		t.Fatalf("bad traffic: %+v", o)
	}
	h.Leave(v)
	if h.Overview().Rooms[0].Participants != 1 {
		t.Fatal("stale participant")
	}
	h.Action(r.ID, owner.ID, "end", "")
	o = h.Overview()
	if len(o.Rooms) != 0 || o.EgressBytes != uint64(len(b)) {
		t.Fatal("ended room or lost total", o)
	}
}

func TestOverviewExcludesExpiredRoomsWithoutMutatingHub(t *testing.T) {
	now := time.Now()
	h := New(Config{Now: func() time.Time { return now }})
	h.Create(owner)
	now = now.Add(31 * time.Minute)
	if len(h.Overview().Rooms) != 0 {
		t.Fatal("expired meeting counted")
	}
	if rooms, _, _ := h.Counts(); rooms != 1 {
		t.Fatal("read changed hub state")
	}
}
