package lanhost

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"testing"
	"time"
	"webzoom/internal/lan"
	"webzoom/internal/media"
	"webzoom/internal/meeting"
)

func TestPolicyAndBroadcast(t *testing.T) {
	p := Policy{Origin: "https://meeting.example", ExtensionID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", InterfaceIP: "192.168.2.4", Port: 34567, MaxMbps: 8}
	if p.Validate("chrome-extension://"+p.ExtensionID+"/") != nil {
		t.Fatal("valid policy")
	}
	if p.Validate("chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/") == nil {
		t.Fatal("foreign extension")
	}
	p.Origin = "http://meeting.example"
	if p.Validate("chrome-extension://"+p.ExtensionID+"/") == nil {
		t.Fatal("insecure origin")
	}
	_, n, _ := net.ParseCIDR("172.16.18.5/22")
	n.IP = net.ParseIP("172.16.18.5")
	if Broadcast(n).String() != "172.16.19.255" {
		t.Fatal(Broadcast(n))
	}
}
func TestConfigureRenewDoesNotReuseNonceAndExpiredLeaseCannotResume(t *testing.T) {
	h := &Host{ctx: context.Background(), output: make(chan any, 10)}
	state := meeting.LANState{Role: "relay", Node: lan.NewID().String(), Room: lan.NewID().String(), Group: lan.NewID().String(), Generation: lan.NewID().String(), Public: base64.StdEncoding.EncodeToString(lan.Public(lan.NewSigner())), Key: base64.StdEncoding.EncodeToString(make([]byte, 32)), LeaseMS: 4000}
	if e := h.configure(state); e != nil {
		t.Fatal(e)
	}
	codec := h.codec
	h.codec.Encode(1, []byte{1})
	if e := h.configure(state); e != nil || h.codec != codec {
		t.Fatal("renew replaced nonce state", e)
	}
	h.lease = time.Now().Add(-time.Second)
	if h.configure(state) == nil {
		t.Fatal("expired key resumed")
	}
	state.Generation = lan.NewID().String()
	if e := h.configure(state); e != nil {
		t.Fatal(e)
	}
	state.Key = "wrong"
	if h.configure(state) == nil {
		t.Fatal("same generation key replacement")
	}
}

func TestNativeCommandChunkDecoding(t *testing.T) {
	var c command
	b := []byte("{\"type\":\"chunk\",\"id\":\"abc\",\"index\":0,\"count\":1,\"data\":\"AQ==\"}")
	if e := json.Unmarshal(b, &c); e != nil || c.Type != "chunk" || c.ID != "abc" || c.Data != "AQ==" {
		t.Fatal(c, e)
	}
}

// Loopback proves real UDP framing/verification only, NOT broadcast or Windows policy acceptance.
func TestRealLoopbackUDPRejectsForgedAndReplayedMedia(t *testing.T) {
	rx, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer rx.Close()
	tx, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Close()
	_, network, _ := net.ParseCIDR("127.0.0.0/8")
	key := bytes.Repeat([]byte{7}, 32)
	signer := lan.NewSigner()
	room, generation, group := lan.NewID(), lan.NewID(), lan.NewID()
	h := &Host{ctx: context.Background(), conn: rx, network: network, policy: Policy{Port: tx.LocalAddr().(*net.UDPAddr).Port}, output: make(chan any, 32), frames: make(chan nativeFrame, 2)}
	s := meeting.LANState{Role: "receiver", Node: lan.NewID().String(), Room: room.String(), Generation: generation.String(), Group: group.String(), Key: base64.StdEncoding.EncodeToString(key), Public: base64.StdEncoding.EncodeToString(lan.Public(signer)), LeaseMS: 4000, Epoch: 1}
	if err := h.configure(s); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { h.receive(); close(done) }()
	defer func() { rx.Close(); <-done }()
	codec, _ := lan.NewCodec(key, group, generation)
	raw := (media.Frame{Epoch: 1, Sequence: 1, Key: true, Width: 640, Height: 360, Payload: bytes.Repeat([]byte{1}, 5000)}).Marshal()
	signed, _ := lan.Sign(signer, room, generation, raw)
	send := func(sequence uint32, b []byte) {
		packets, e := codec.Encode(sequence, b)
		if e != nil {
			t.Fatal(e)
		}
		for i := len(packets) - 1; i >= 0; i-- {
			if _, e := tx.WriteToUDP(packets[i], rx.LocalAddr().(*net.UDPAddr)); e != nil {
				t.Fatal(e)
			}
		}
	}
	send(1, signed)
	select {
	case f := <-h.frames:
		if !bytes.Equal(f.data, raw) || f.generation != generation.String() {
			t.Fatal("UDP round trip mismatch")
		}
	case <-time.After(time.Second):
		t.Fatal("UDP timeout")
	}
	// A group member knows AES key, but cannot replace server signature or replay an older signed frame.
	send(200, signed)
	forged := bytes.Clone(signed)
	forged[100] ^= 1
	send(300, forged)
	select {
	case <-h.frames:
		t.Fatal("accepted replay or forgery")
	case <-time.After(100 * time.Millisecond):
	}
	raw2 := (media.Frame{Epoch: 1, Sequence: 2, Key: true, Width: 640, Height: 360, Payload: []byte{2}}).Marshal()
	signed2, _ := lan.Sign(signer, room, generation, raw2)
	send(2, signed2)
	select {
	case f := <-h.frames:
		if !bytes.Equal(f.data, raw2) {
			t.Fatal("forgery poisoned signed sequence")
		}
	case <-time.After(time.Second):
		t.Fatal("valid frame blocked after forgery")
	}
}

func TestProbeReportCacheRecoversAfterReachingCapacity(t *testing.T) {
	now := time.Unix(100, 0)
	reported := map[string]time.Time{}
	for i := 0; i < 256; i++ {
		reported[lan.NewID().String()] = now
	}
	if allowProbeReport(reported, "new", now) {
		t.Fatal("full cache exceeded")
	}
	if !allowProbeReport(reported, "new", now.Add(6*time.Second)) || len(reported) != 1 {
		t.Fatal("full cache failed to expire")
	}
	if allowProbeReport(reported, "new", now.Add(6500*time.Millisecond)) {
		t.Fatal("same-node rate limit bypassed")
	}
	if !allowProbeReport(reported, "new", now.Add(7*time.Second)) {
		t.Fatal("same-node report did not recover")
	}
}
