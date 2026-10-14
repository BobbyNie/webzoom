package lan

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"testing"
	"time"
	"webzoom/internal/media"
)

func sample(size int) []byte {
	return (media.Frame{Epoch: 7, Sequence: 12, Key: true, Width: 1920, Height: 1080, Timestamp: 123, Payload: bytes.Repeat([]byte{42}, size)}).Marshal()
}
func TestSignedEncryptedRoundTripAndReplay(t *testing.T) {
	key := bytes.Repeat([]byte{1}, 32)
	room, gen, group := NewID(), NewID(), NewID()
	signer := NewSigner()
	raw := sample(150000)
	signed, e := Sign(signer, room, gen, raw)
	if e != nil {
		t.Fatal(e)
	}
	tx, _ := NewCodec(key, group, gen)
	rx, _ := NewCodec(key, group, gen)
	packets, e := tx.Encode(12, signed)
	if e != nil {
		t.Fatal(e)
	}
	var rebuilt []byte
	for i := len(packets) - 1; i >= 0; i-- {
		if len(packets[i]) > 1200 {
			t.Fatal("oversized UDP")
		}
		b, e := rx.Decode(packets[i], time.Now())
		if e != nil {
			t.Fatal(e)
		}
		if b != nil {
			rebuilt = b
		}
	}
	got, e := Verify(Public(signer), room, gen, rebuilt)
	if e != nil || !bytes.Equal(got, raw) {
		t.Fatal("signature round trip", e)
	}
	rx.Accept(12)
	if _, e = rx.Decode(packets[0], time.Now()); e == nil {
		t.Fatal("replay accepted")
	}
	if _, e = Verify(Public(signer), NewID(), gen, signed); e == nil {
		t.Fatal("wrong meeting")
	}
	if _, e = Verify(Public(signer), room, NewID(), signed); e == nil {
		t.Fatal("wrong generation")
	}
	signed[40] ^= 1
	if _, e = Verify(Public(signer), room, gen, signed); e == nil {
		t.Fatal("forgery")
	}
}
func TestDatagramTamperLimitsAndExpiry(t *testing.T) {
	key := bytes.Repeat([]byte{2}, 32)
	group, gen := NewID(), NewID()
	tx, _ := NewCodec(key, group, gen)
	rx, _ := NewCodec(key, group, gen)
	packets, _ := tx.Encode(1, bytes.Repeat([]byte{1}, 5000))
	bad := bytes.Clone(packets[0])
	bad[len(bad)-1] ^= 1
	if _, e := rx.Decode(bad, time.Now()); e == nil {
		t.Fatal("tamper")
	}
	if _, e := rx.Decode(packets[0], time.Now()); e != nil {
		t.Fatal(e)
	}
	rx.Expire(time.Now().Add(time.Second))
	if rx.buffered != 0 || len(rx.parts) != 0 {
		t.Fatal("expiry leak")
	}
	if _, e := tx.Encode(1, make([]byte, MaxEnvelope+1)); e == nil {
		t.Fatal("size")
	}
	if _, e := NewCodec(key[:16], group, gen); e == nil {
		t.Fatal("short key")
	}
	bad = bytes.Clone(packets[1])
	binary.BigEndian.PutUint32(bad[52:56], 0xffffffff)
	if _, e := rx.Decode(bad, time.Now()); e == nil {
		t.Fatal("unbounded allocation")
	}
}
func TestMaximumFrameAndIPC(t *testing.T) {
	signer := NewSigner()
	room, gen := NewID(), NewID()
	b, e := Sign(signer, room, gen, sample(media.MaxFrameSize-media.HeaderSize))
	if e != nil || len(b) != MaxEnvelope {
		t.Fatal(len(b), e)
	}
	var chunks Chunks
	var result []byte
	count := (len(b) + IPCChunk - 1) / IPCChunk
	for i := 0; i < count; i++ {
		end := (i + 1) * IPCChunk
		if end > len(b) {
			end = len(b)
		}
		v := Chunk{Type: "chunk", ID: "frame", Index: i, Count: count, Data: base64.StdEncoding.EncodeToString(b[i*IPCChunk : end])}
		var stream bytes.Buffer
		if e := WriteMessage(&stream, v); e != nil {
			t.Fatal(e)
		}
		var decoded Chunk
		if e := ReadMessage(&stream, &decoded); e != nil {
			t.Fatal(e)
		}
		result, e = chunks.Add(decoded, time.Now())
		if e != nil {
			t.Fatal(e)
		}
	}
	if !bytes.Equal(b, result) {
		t.Fatal("IPC roundtrip")
	}
	var v any
	if ReadMessage(bytes.NewReader([]byte{0xff, 0xff, 0xff, 0xff}), &v) == nil {
		t.Fatal("unbounded prefix")
	}
}
func TestIncompleteAssembliesAreBounded(t *testing.T) {
	key := make([]byte, 32)
	group, gen := NewID(), NewID()
	tx, _ := NewCodec(key, group, gen)
	rx, _ := NewCodec(key, group, gen)
	for seq := uint32(0); seq < 100; seq++ {
		p, _ := tx.Encode(seq, make([]byte, 2000))
		rx.Decode(p[0], time.Now())
	}
	if len(rx.parts) > MaxAssemblies || rx.buffered > MaxBuffered {
		t.Fatal("unbounded reassembly")
	}
}
func FuzzDecode(f *testing.F) {
	f.Add([]byte("WZU1"))
	f.Fuzz(func(t *testing.T, b []byte) {
		rx, _ := NewCodec(make([]byte, 32), ID{}, ID{})
		rx.Decode(b, time.Unix(100, 0))
	})
}
func FuzzNativeLength(f *testing.F) {
	f.Add([]byte{1, 0, 0, 0, '{'})
	f.Fuzz(func(t *testing.T, b []byte) { var v any; ReadMessage(bytes.NewReader(b), &v) })
}

func TestPacingDebtSurvivesFrameBoundaries(t *testing.T) {
	p := Pacer{Mbps: 8}
	now := time.Now()
	var delay time.Duration
	for i := 0; i < 100; i++ {
		delay = p.Delay(1000, now)
	}
	if delay != 90*time.Millisecond {
		t.Fatal(delay)
	}
	if p.Delay(1000, now.Add(time.Second)) != 0 {
		t.Fatal("idle recovery")
	}
}

// Virtual packet arrival times exercise the real pacer and codec without claiming
// real-network latency. A total 750ms deadline cannot carry 1MiB even at 8Mbps.
func TestMaximumFrameSurvivesSupportedPacingRates(t *testing.T) {
	for _, mbps := range []int{1, 8} {
		key := bytes.Repeat([]byte{9}, 32)
		room, generation, group := NewID(), NewID(), NewID()
		signer := NewSigner()
		raw := sample(media.MaxFrameSize - media.HeaderSize)
		signed, err := Sign(signer, room, generation, raw)
		if err != nil {
			t.Fatal(err)
		}
		tx, _ := NewCodec(key, group, generation)
		rx, _ := NewCodec(key, group, generation)
		packets, err := tx.Encode(12, signed)
		if err != nil {
			t.Fatal(err)
		}
		pacer := Pacer{Mbps: mbps}
		start := time.Unix(100, 0)
		now := start
		var rebuilt []byte
		for _, packet := range packets {
			now = now.Add(pacer.Delay(len(packet)+28, now))
			rebuilt, err = rx.Decode(packet, now)
			if err != nil {
				t.Fatalf("%d Mbps: %v", mbps, err)
			}
		}
		if now.Sub(start) <= AssemblyTTL || now.Sub(start) >= MaxAssemblyLifetime {
			t.Fatalf("unexpected paced duration: %v", now.Sub(start))
		}
		verified, err := Verify(Public(signer), room, generation, rebuilt)
		if err != nil || !bytes.Equal(raw, verified) {
			t.Fatalf("%d Mbps maximum frame lost: %v", mbps, err)
		}
	}
}

func TestAssemblyHardLifetimeBoundsContinuousFragments(t *testing.T) {
	key := make([]byte, 32)
	group, generation := NewID(), NewID()
	tx, _ := NewCodec(key, group, generation)
	rx, _ := NewCodec(key, group, generation)
	packets, _ := tx.Encode(1, make([]byte, 100000))
	start := time.Unix(100, 0)
	for i := 0; i <= 20; i++ {
		if _, err := rx.Decode(packets[i], start.Add(time.Duration(i)*500*time.Millisecond)); err != nil {
			t.Fatal(err)
		}
	}
	if len(rx.parts) != 1 {
		t.Fatal("active assembly lost before hard lifetime")
	}
	rx.Expire(start.Add(MaxAssemblyLifetime + time.Nanosecond))
	if len(rx.parts) != 0 || rx.buffered != 0 {
		t.Fatal("continuous fragments bypassed hard lifetime")
	}
}
