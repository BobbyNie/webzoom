//go:build windows && amd64

package main

import (
	"runtime"
	"testing"
	"unsafe"
	"webzoom/internal/meeting"
	"webzoom/internal/overlayclient"
)

func TestNativeLayoutAndColors(t *testing.T) {
	if unsafe.Sizeof(wndClass{}) != 80 || unsafe.Sizeof(message{}) != 48 || unsafe.Sizeof(paintStruct{}) != 72 || unsafe.Sizeof(monitorInfo{}) != 104 {
		t.Fatal("Win32 ABI layout mismatch")
	}
	for color, want := range map[string]uintptr{"#e53935": 0x3539e5, "#2563eb": 0xeb6325, "#16a34a": 0x4aa316, "#f59e0b": 0x0b9ef5, "invalid": 0} {
		if got := rgb(color); got != want {
			t.Fatalf("%s: got %x want %x", color, got, want)
		}
	}
}

// Uses a synthetic off-screen canvas: no screenshots and no personal screen data.
func TestNativeAnnotationRendering(t *testing.T) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	dc := ucall("GetDC", 0)
	if dc == 0 {
		t.Fatal("display device unavailable")
	}
	defer ucall("ReleaseDC", 0, dc)
	mem := gcall("CreateCompatibleDC", dc)
	if mem == 0 {
		t.Fatal("memory DC unavailable")
	}
	defer gcall("DeleteDC", mem)
	bitmap := gcall("CreateCompatibleBitmap", dc, 401, 201)
	if bitmap == 0 {
		t.Fatal("bitmap unavailable")
	}
	defer gcall("DeleteObject", bitmap)
	old := gcall("SelectObject", mem, bitmap)
	defer gcall("SelectObject", mem, old)
	m := overlayclient.Model{Strokes: []meeting.Stroke{{Color: "#e53935", Points: []meeting.Point{{X: .25, Y: .5}, {X: .75, Y: .5}}}}, Pointers: map[string]overlayclient.Pointer{"p": {Color: "#2563eb", Point: meeting.Point{X: .25, Y: .25}, User: meeting.User{Name: "Pointer"}}}}
	paintScene(mem, 401, 201, &m)
	for _, p := range []struct {
		x, y  int
		color uintptr
	}{{5, 5, 0xff00ff}, {200, 100, rgb("#e53935")}, {100, 50, rgb("#2563eb")}} {
		if got := gcall("GetPixel", mem, uintptr(p.x), uintptr(p.y)); got != p.color {
			t.Fatalf("pixel (%d,%d): got %x want %x", p.x, p.y, got, p.color)
		}
	}
	m.Clear()
	paintScene(mem, 401, 201, &m)
	if got := gcall("GetPixel", mem, 200, 100); got != 0xff00ff {
		t.Fatal("clear left stale pixels", got)
	}
}
