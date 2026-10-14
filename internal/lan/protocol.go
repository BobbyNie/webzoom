// Package lan implements the versioned, bounded LAN media transport.
package lan

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"math/big"
	"time"
	"webzoom/internal/media"
)

const (
	MaxEnvelope         = media.MaxFrameSize + 100
	DatagramSize        = 1200
	HeaderSize          = 56
	FragmentSize        = DatagramSize - HeaderSize - 16
	MaxAssemblies       = 8
	MaxBuffered         = 8 << 20
	AssemblyTTL         = 750 * time.Millisecond // idle deadline between accepted fragments
	MaxAssemblyLifetime = 10 * time.Second       // maximum frame at the slowest supported 1 Mbps, plus margin
)

var ErrInvalid = errors.New("invalid LAN message")

type ID [16]byte

func NewID() ID {
	var id ID
	if _, e := rand.Read(id[:]); e != nil {
		panic(e)
	}
	return id
}
func (id ID) String() string { return hex.EncodeToString(id[:]) }
func ParseID(s string) (ID, error) {
	var id ID
	b, e := hex.DecodeString(s)
	if e != nil || len(b) != 16 {
		return id, ErrInvalid
	}
	copy(id[:], b)
	return id, nil
}
func NewSigner() *ecdsa.PrivateKey {
	k, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		panic(e)
	}
	return k
}
func Public(k *ecdsa.PrivateKey) []byte { return elliptic.Marshal(elliptic.P256(), k.X, k.Y) }

// WZS1 | room(16) | generation(16) | WZ01 frame | r(32) | s(32).
func Sign(k *ecdsa.PrivateKey, room, generation ID, raw []byte) ([]byte, error) {
	if _, e := media.Parse(raw); e != nil {
		return nil, e
	}
	b := make([]byte, 36+len(raw)+64)
	copy(b, "WZS1")
	copy(b[4:20], room[:])
	copy(b[20:36], generation[:])
	copy(b[36:], raw)
	sum := sha256.Sum256(b[:len(b)-64])
	r, s, e := ecdsa.Sign(rand.Reader, k, sum[:])
	if e != nil {
		return nil, e
	}
	r.FillBytes(b[len(b)-64 : len(b)-32])
	s.FillBytes(b[len(b)-32:])
	return b, nil
}
func Verify(pub []byte, room, generation ID, b []byte) ([]byte, error) {
	if len(b) <= 132 || len(b) > MaxEnvelope || string(b[:4]) != "WZS1" || string(b[4:20]) != string(room[:]) || string(b[20:36]) != string(generation[:]) {
		return nil, ErrInvalid
	}
	x, y := elliptic.Unmarshal(elliptic.P256(), pub)
	if x == nil {
		return nil, ErrInvalid
	}
	sum := sha256.Sum256(b[:len(b)-64])
	r := new(big.Int).SetBytes(b[len(b)-64 : len(b)-32])
	s := new(big.Int).SetBytes(b[len(b)-32:])
	if !ecdsa.Verify(&ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}, sum[:], r, s) {
		return nil, ErrInvalid
	}
	raw := b[36 : len(b)-64]
	if _, e := media.Parse(raw); e != nil {
		return nil, e
	}
	return raw, nil
}

// A new key is mandatory for every generation. One sender owns its nonce counter.
type Codec struct {
	aead              cipher.AEAD
	Group, Generation ID
	counter           uint64
	high              uint64
	seen              map[uint64]bool
	parts             map[uint32]*assembly
	buffered          int
	last              uint32
	completed         bool
}
type assembly struct {
	at, last time.Time
	total    int
	count    int
	parts    map[int][]byte
	bytes    int
}

func NewCodec(key []byte, group, generation ID) (*Codec, error) {
	if len(key) != 32 {
		return nil, ErrInvalid
	}
	block, e := aes.NewCipher(key)
	if e != nil {
		return nil, e
	}
	a, e := cipher.NewGCM(block)
	if e != nil {
		return nil, e
	}
	return &Codec{aead: a, Group: group, Generation: generation, seen: map[uint64]bool{}, parts: map[uint32]*assembly{}}, nil
}
func (c *Codec) Encode(sequence uint32, b []byte) ([][]byte, error) {
	if len(b) == 0 || len(b) > MaxEnvelope {
		return nil, ErrInvalid
	}
	count := (len(b) + FragmentSize - 1) / FragmentSize
	out := make([][]byte, 0, count)
	for i := 0; i < count; i++ {
		if c.counter == ^uint64(0) {
			return nil, ErrInvalid
		}
		c.counter++
		h := make([]byte, HeaderSize)
		copy(h, "WZU1")
		copy(h[4:20], c.Group[:])
		copy(h[20:36], c.Generation[:])
		binary.BigEndian.PutUint64(h[36:44], c.counter)
		binary.BigEndian.PutUint32(h[44:48], sequence)
		binary.BigEndian.PutUint16(h[48:50], uint16(i))
		binary.BigEndian.PutUint16(h[50:52], uint16(count))
		binary.BigEndian.PutUint32(h[52:56], uint32(len(b)))
		var nonce [12]byte
		copy(nonce[4:], h[36:44])
		end := (i + 1) * FragmentSize
		if end > len(b) {
			end = len(b)
		}
		out = append(out, c.aead.Seal(h, nonce[:], b[i*FragmentSize:end], h))
	}
	return out, nil
}
func (c *Codec) Expire(now time.Time) {
	for seq, a := range c.parts {
		if now.Sub(a.last) > AssemblyTTL || now.Sub(a.at) > MaxAssemblyLifetime {
			c.buffered -= a.bytes
			delete(c.parts, seq)
		}
	}
}
func (c *Codec) Decode(b []byte, now time.Time) ([]byte, error) {
	c.Expire(now)
	if len(b) < HeaderSize+17 || len(b) > DatagramSize || string(b[:4]) != "WZU1" || string(b[4:20]) != string(c.Group[:]) || string(b[20:36]) != string(c.Generation[:]) {
		return nil, ErrInvalid
	}
	n := binary.BigEndian.Uint64(b[36:44])
	seq := binary.BigEndian.Uint32(b[44:48])
	idx := int(binary.BigEndian.Uint16(b[48:50]))
	count := int(binary.BigEndian.Uint16(b[50:52]))
	total := int(binary.BigEndian.Uint32(b[52:56]))
	if n == 0 || c.seen[n] || (c.high >= 4096 && n <= c.high-4096) || total <= 0 || total > MaxEnvelope || count != (total+FragmentSize-1)/FragmentSize || idx >= count || (c.completed && seq <= c.last) {
		return nil, ErrInvalid
	}
	expected := FragmentSize
	if idx == count-1 {
		expected = total - idx*FragmentSize
	}
	if len(b) != HeaderSize+16+expected {
		return nil, ErrInvalid
	}
	var nonce [12]byte
	copy(nonce[4:], b[36:44])
	plain, e := c.aead.Open(nil, nonce[:], b[HeaderSize:], b[:HeaderSize])
	if e != nil {
		return nil, ErrInvalid
	}
	if n > c.high {
		if n-c.high > 4096 {
			clear(c.seen)
		} else {
			for step := uint64(1); step <= n-c.high; step++ {
				v := c.high + step
				if v >= 4096 {
					delete(c.seen, v-4096)
				}
			}
		}
		c.high = n
	}
	c.seen[n] = true
	a := c.parts[seq]
	if a == nil {
		if len(c.parts) >= MaxAssemblies {
			return nil, ErrInvalid
		}
		a = &assembly{at: now, last: now, total: total, count: count, parts: map[int][]byte{}}
		c.parts[seq] = a
	}
	if a.total != total || a.count != count || a.parts[idx] != nil || c.buffered+len(plain) > MaxBuffered {
		return nil, ErrInvalid
	}
	a.last = now
	a.parts[idx] = plain
	a.bytes += len(plain)
	c.buffered += len(plain)
	if len(a.parts) != count {
		return nil, nil
	}
	out := make([]byte, 0, total)
	for i := 0; i < count; i++ {
		out = append(out, a.parts[i]...)
	}
	c.buffered -= a.bytes
	delete(c.parts, seq)
	return out, nil
}

// Accept is called only after server signature and media epoch validation.
func (c *Codec) Accept(seq uint32) {
	c.last = seq
	c.completed = true
	for s, a := range c.parts {
		if s <= seq {
			c.buffered -= a.bytes
			delete(c.parts, s)
		}
	}
}
