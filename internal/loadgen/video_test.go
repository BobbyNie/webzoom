package loadgen

import (
	"bytes"
	"encoding/binary"
	"testing"
)

func TestIVFValidation(t *testing.T) {
	if _, e := ReadIVF(bytes.NewReader([]byte("bad"))); e == nil {
		t.Fatal("bad IVF accepted")
	}
	b := make([]byte, 32+12+4)
	copy(b, "DKIF")
	binary.LittleEndian.PutUint16(b[6:8], 32)
	copy(b[8:12], "VP80")
	binary.LittleEndian.PutUint16(b[12:14], 1920)
	binary.LittleEndian.PutUint16(b[14:16], 1080)
	binary.LittleEndian.PutUint32(b[32:36], 4)
	f, e := ReadIVF(bytes.NewReader(b))
	if e != nil || len(f) != 1 || !f[0].Key || f[0].Width != 1920 {
		t.Fatal(f, e)
	}
	b[44] = 1
	if _, e = ReadIVF(bytes.NewReader(b)); e == nil {
		t.Fatal("file must begin with key")
	}
}
func TestDistribution(t *testing.T) {
	var h Histogram
	for i := 0; i < 100; i++ {
		h.Add(50)
	}
	for i := 0; i < 4; i++ {
		h.Add(1500)
	}
	if h.P95() != 100 {
		t.Fatal(h.P95())
	}
}
