package meeting

import (
	"encoding/binary"
	"testing"
	"time"
)

// Advances the scheduler clock, not wall time. Frames are tiny synthetic protocol
// payloads consumed in memory, not a capacity/decoding/network benchmark.
func TestBrowserRelayTwoHourLogicalClockWith64Viewers(t *testing.T) {
	now := time.Date(2026, 10, 21, 0, 0, 0, 0, time.UTC)
	h, r, people := relayFixtureConfig(t, Config{BrowserRelayEnabled: true, BandwidthLimitMbps: 200, Now: func() time.Time { return now }}, 64)
	active := relayStart(t, h, r)
	var sequence uint32
	for second := 0; second < 7200; second++ {
		now = now.Add(time.Second)
		if second > 0 && second%600 == 0 {
			oldEpoch := active.Epoch
			if _, err := h.Action(r.ID, owner.ID, "stop", ""); err != nil {
				t.Fatal(err)
			}
			for _, p := range people {
				stopped := relayPlan(p)
				if stopped == nil || stopped.Active || len(stopped.Links) != 0 || p.Media.Len() != 0 {
					t.Fatal("stop retained a source or queued media")
				}
			}
			active = relayStart(t, h, r)
			if active.Epoch <= oldEpoch {
				t.Fatal("new share reused an old epoch")
			}
			if err := h.Publish(people[0], frame(oldEpoch, sequence+1, true)); err != ErrForbidden {
				t.Fatalf("old epoch accepted: %v", err)
			}
			sequence = 0
		}
		for _, p := range people {
			relayPlan(p)
		}
		sequence++
		payload := frame(active.Epoch, sequence, true)
		binary.BigEndian.PutUint64(payload[16:24], uint64(now.UnixMicro()))
		if err := h.Publish(people[0], payload); err != nil {
			t.Fatal(err)
		}
		roots := 0
		for _, p := range people {
			_, received := p.Media.Pop()
			expected := h.rooms[r.ID].browser.roots[p.User.ID]
			if received != expected || p.Media.Len() != 0 {
				t.Fatal("server routing or queue consumption diverged")
			}
			if received {
				roots++
			}
			select {
			case <-p.Done:
				t.Fatalf("unexpected disconnect at second %d", second)
			default:
			}
		}
		if roots != 16 {
			t.Fatalf("unexpected root count %d", roots)
		}
		if reserved := h.browserReservedExcept(nil) * browserReservationMbps; reserved > 200 {
			t.Fatal("global reservation exceeded")
		}
	}
	if h.Metrics.Dropped.Load() != 0 {
		t.Fatal("healthy synthetic consumers dropped frames")
	}
	rooms, connections, queued := h.Counts()
	if rooms != 1 || connections != 65 || queued != 0 {
		t.Fatalf("unexpected end state: %d/%d/%d", rooms, connections, queued)
	}
}
