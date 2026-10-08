package media

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestFrameRoundTripAndValidation(t *testing.T) {
	f := Frame{Epoch: 7, Sequence: 8, Timestamp: 123456789, Key: true, Width: 1920, Height: 1080, Payload: []byte{1, 2, 3}}
	b := f.Marshal()
	got, err := Parse(b)
	if err != nil || got.Epoch != 7 || got.Timestamp != f.Timestamp || !got.Key || !bytes.Equal(got.Payload, f.Payload) {
		t.Fatalf("roundtrip: %+v %v", got, err)
	}
	tests := map[string][]byte{"short": b[:10], "empty": b[:HeaderSize], "oversize": make([]byte, MaxFrameSize+1)}
	bad := append([]byte(nil), b...)
	bad[0] = 'X'
	tests["magic"] = bad
	bad = append([]byte(nil), b...)
	binary.BigEndian.PutUint16(bad[24:26], 4096)
	tests["dimensions"] = bad
	bad = append([]byte(nil), b...)
	bad[4] = 2
	tests["flags"] = bad
	for name, v := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse(v); err == nil {
				t.Fatal("accepted invalid frame")
			}
		})
	}
}
func TestQueueRequiresKeyFrameAndBoundsBacklog(t *testing.T) {
	q := NewQueue(2, 1000)
	delta := Frame{Payload: []byte{1}}.Marshal()
	key := Frame{Key: true, Payload: []byte{1}}.Marshal()
	if q.Push(delta, false) {
		t.Fatal("delta before key")
	}
	if !q.Push(key, true) || !q.Push(delta, false) {
		t.Fatal("normal push")
	}
	if q.Push(delta, false) {
		t.Fatal("overflow must discard dependent frames")
	}
	if q.Len() != 0 || !q.Waiting() {
		t.Fatal("backlog not cleared")
	}
	if !q.Push(key, true) {
		t.Fatal("key did not recover")
	}
	if b, ok := q.Pop(); !ok || !bytes.Equal(b, key) {
		t.Fatal("key not delivered")
	}
	q.Reset()
	if q.Push(delta, false) {
		t.Fatal("reset must need key")
	}
}
func TestQueueByteLimit(t *testing.T) {
	q := NewQueue(10, 4)
	if q.Push(make([]byte, 5), true) {
		t.Fatal("accepted over budget")
	}
	if !q.Push([]byte{1, 2, 3}, true) {
		t.Fatal("key rejected")
	}
	if q.Push([]byte{1, 2}, false) || q.Len() != 0 {
		t.Fatal("byte overflow not bounded")
	}
}
func BenchmarkFanout200(b *testing.B) {
	qs := make([]*Queue, 200)
	for i := range qs {
		qs[i] = NewQueue(8, 2<<20)
	}
	data := make([]byte, 24<<10)
	b.SetBytes(int64(len(data) * 200))
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		for _, q := range qs {
			q.Push(data, true)
			q.Pop()
		}
	}
}
