package meeting

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"
	"webzoom/internal/bandwidth"
)

func TestBandwidthAdmissionLeavesExistingMeetingsRunning(t *testing.T) {
	now := time.Now()
	h := New(Config{Now: func() time.Time { return now }, BandwidthLimitMbps: 1})
	r, _ := h.Create(owner)
	p, _ := h.Join(r.ID, owner, "s1")
	v, _ := h.Join(r.ID, viewer, "s2")
	s, _ := h.Action(r.ID, owner.ID, "start", "")
	b := frame(s.Epoch, 1, true)
	if err := h.Publish(p, b); err != nil {
		t.Fatal(err)
	}
	h.RecordEgress(v, 625000-len(b)) // Both directions count. Equality remains open.
	if h.BandwidthStatus().Blocked {
		t.Fatal("equality incorrectly blocked")
	}
	h.RecordEgress(v, 1)
	before, connections, _ := h.Counts()
	if _, err := h.Create(owner); !errors.Is(err, ErrBandwidth) {
		t.Fatal(err)
	}
	if _, err := h.Join(r.ID, User{ID: "late"}, "s3"); !errors.Is(err, ErrBandwidth) {
		t.Fatal(err)
	}
	after, afterConnections, _ := h.Counts()
	if before != after || connections != afterConnections {
		t.Fatal("denied admission changed state")
	}
	if err := h.Publish(p, frame(s.Epoch, 2, true)); err != nil {
		t.Fatal("existing publisher stopped", err)
	}
	if _, err := h.Action(r.ID, owner.ID, "stop", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := h.Action(r.ID, owner.ID, "transfer", viewer.ID); err != nil {
		t.Fatal(err)
	}
	h.Leave(v)
	if _, err := h.Join(r.ID, viewer, "s2"); !errors.Is(err, ErrBandwidth) {
		t.Fatal("reconnect bypassed policy", err)
	}
	if _, err := h.Action(r.ID, owner.ID, "end", ""); err != nil {
		t.Fatal("owner cannot end overloaded meeting", err)
	}
	now = now.Add(5 * time.Second)
	if _, err := h.Create(owner); err != nil {
		t.Fatal("admission did not recover", err)
	}
}

func TestBandwidthIncludesEveryMeetingAndOnlyAcceptedMedia(t *testing.T) {
	h, r, p, v := setup(t)
	if _, err := h.SetBandwidthLimit(1); err != nil {
		t.Fatal(err)
	}
	second, _ := h.Create(User{ID: "second"})
	other, _ := h.Join(second.ID, User{ID: "second"}, "s3")
	if err := h.Publish(v, frame(0, 1, true)); err == nil {
		t.Fatal("unauthorized media accepted")
	}
	h.RecordEgress(v, 0)
	h.RecordEgress(v, -1)
	if h.BandwidthStatus().TotalMbps != 0 {
		t.Fatal("invalid media counted")
	}
	h.RecordEgress(v, 400000)
	h.RecordEgress(other, 225001)
	if s := h.Overview().Bandwidth; !s.Blocked || s.LimitMbps != 1 {
		t.Fatal(s)
	}
	h.EndRooms([]string{second.ID}) // Removal must not erase the current service traffic.
	if !h.BandwidthStatus().Blocked {
		t.Fatal("ended meeting erased rolling traffic")
	}
	if _, err := h.Action(r.ID, p.User.ID, "end", ""); err != nil {
		t.Fatal(err)
	}
}

func TestSavedBandwidthSurvivesNewHubAndConcurrentChanges(t *testing.T) {
	store := bandwidth.FileStore{Path: filepath.Join(t.TempDir(), "bandwidth.json")}
	h := New(Config{SaveBandwidthLimit: store.Save})
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				_, err := h.SetBandwidthLimit(i + 1)
				if err != nil {
					t.Error(err)
				}
				r, err := h.Create(User{ID: fmt.Sprint(i)})
				if err == nil {
					p, err := h.Join(r.ID, User{ID: fmt.Sprint(i)}, "s")
					if err == nil {
						h.RecordEgress(p, 100)
						h.Leave(p)
					}
					h.EndRooms([]string{r.ID})
				}
			}
		}(i)
	}
	wg.Wait()
	saved, err := store.Load(200)
	if err != nil {
		t.Fatal(err)
	}
	restarted := New(Config{BandwidthLimitMbps: saved, SaveBandwidthLimit: store.Save})
	if restarted.BandwidthStatus().LimitMbps != h.BandwidthStatus().LimitMbps || restarted.BandwidthStatus().TotalMbps != 0 {
		t.Fatal("restart reset saved limit")
	}
}
