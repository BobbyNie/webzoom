package lan

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"time"
)

const MaxMessage = 64 << 10
const IPCChunk = 32 << 10

// Native Messaging uses a little-endian length on supported Windows x64 hosts.
func ReadMessage(r io.Reader, v any) error {
	var h [4]byte
	if _, e := io.ReadFull(r, h[:]); e != nil {
		return e
	}
	n := binary.LittleEndian.Uint32(h[:])
	if n == 0 || n > MaxMessage {
		return ErrInvalid
	}
	b := make([]byte, n)
	if _, e := io.ReadFull(r, b); e != nil {
		return e
	}
	return json.Unmarshal(b, v)
}
func WriteMessage(w io.Writer, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if len(b) > MaxMessage {
		return ErrInvalid
	}
	var h [4]byte
	binary.LittleEndian.PutUint32(h[:], uint32(len(b)))
	if _, e = w.Write(h[:]); e != nil {
		return e
	}
	_, e = w.Write(b)
	return e
}

type Chunk struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Index int    `json:"index"`
	Count int    `json:"count"`
	Data  string `json:"data"`
}
type Chunks struct {
	id          string
	next, count int
	data        []byte
	started     time.Time
}

func (c *Chunks) Add(v Chunk, now time.Time) ([]byte, error) {
	if len(v.ID) > 64 || v.ID == "" || v.Count < 1 || v.Count > (MaxEnvelope+IPCChunk-1)/IPCChunk || v.Index < 0 || v.Index >= v.Count || len(v.Data) > ((IPCChunk+2)/3)*4 {
		return nil, ErrInvalid
	}
	if v.Index == 0 {
		*c = Chunks{id: v.ID, count: v.Count, started: now}
	}
	if c.id != v.ID || c.next != v.Index || c.count != v.Count || now.Sub(c.started) > time.Second {
		return nil, ErrInvalid
	}
	b, e := base64.StdEncoding.DecodeString(v.Data)
	if e != nil || len(b) > IPCChunk || len(b) == 0 || len(c.data)+len(b) > MaxEnvelope {
		return nil, ErrInvalid
	}
	c.data = append(c.data, b...)
	c.next++
	if c.next != c.count {
		return nil, nil
	}
	out := c.data
	*c = Chunks{}
	return out, nil
}
