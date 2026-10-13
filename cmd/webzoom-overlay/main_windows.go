//go:build windows && amd64

// The helper uses only the Windows desktop API and Go's standard TLS trust.
// It creates no service, listener, browser extension, or registry registration.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/coder/websocket"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
	"webzoom/internal/meeting"
	"webzoom/internal/overlayclient"
)

var (
	user32        = syscall.NewLazyDLL("user32.dll")
	gdi32         = syscall.NewLazyDLL("gdi32.dll")
	kernel32      = syscall.NewLazyDLL("kernel32.dll")
	proc          = syscall.NewCallback(windowProc)
	window        uintptr
	model         overlayclient.Model
	incoming      = make(chan meeting.Event, 64)
	stopped       = make(chan error, 1)
	stoppedReason error
	paused        bool
	screen        monitor
	shown         bool
)

func ucall(name string, args ...uintptr) uintptr {
	r, _, _ := user32.NewProc(name).Call(args...)
	return r
}
func gcall(name string, args ...uintptr) uintptr {
	r, _, _ := gdi32.NewProc(name).Call(args...)
	return r
}
func text(s string) *uint16 { p, _ := syscall.UTF16PtrFromString(s); return p }
func ptr(p *uint16) uintptr { return uintptr(unsafe.Pointer(p)) }

type point struct{ X, Y int32 }
type rect struct{ Left, Top, Right, Bottom int32 }
type monitorInfo struct {
	Size          uint32
	Monitor, Work rect
	Flags         uint32
	Device        [32]uint16
}
type monitor struct {
	Bounds  rect
	Name    string
	Primary bool
}
type wndClass struct {
	Size, Style                        uint32
	Proc                               uintptr
	ClassExtra, WindowExtra            int32
	Instance, Icon, Cursor, Background uintptr
	Menu, Name                         *uint16
	SmallIcon                          uintptr
}
type message struct {
	Window  uintptr
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Point   point
	Private uint32
}
type paintStruct struct {
	DC                 uintptr
	Erase              int32
	Paint              rect
	Restore, IncUpdate int32
	Reserved           [32]byte
}

func monitors() []monitor {
	var result []monitor
	callback := syscall.NewCallback(func(handle, dc, area, data uintptr) uintptr {
		info := monitorInfo{Size: uint32(unsafe.Sizeof(monitorInfo{}))}
		if ucall("GetMonitorInfoW", handle, uintptr(unsafe.Pointer(&info))) != 0 {
			name := syscall.UTF16ToString(info.Device[:])
			result = append(result, monitor{info.Monitor, name, info.Flags&1 != 0})
		}
		return 1
	})
	ucall("EnumDisplayMonitors", 0, 0, callback, 0)
	return result
}
func supportedWindows() bool {
	// RTL_OSVERSIONINFOW. Unlike compatibility-shimmed GetVersionEx, this reports
	// the real build. Older Windows can turn exclusion into a black rectangle.
	var version struct {
		Size, Major, Minor, Build, Platform uint32
		ServicePack                         [128]uint16
	}
	version.Size = uint32(unsafe.Sizeof(version))
	r, _, _ := syscall.NewLazyDLL("ntdll.dll").NewProc("RtlGetVersion").Call(uintptr(unsafe.Pointer(&version)))
	return r == 0 && version.Major >= 10 && version.Build >= 19041
}
func main() {
	runtime.LockOSThread()
	err := run()
	if err != nil {
		fmt.Println("Stopped:", err)
	}
	if len(os.Args) > 1 && os.Args[1] == "--self-test" {
		if err != nil {
			os.Exit(1)
		}
		return
	}
	fmt.Println("Press Enter to close.")
	bufio.NewReader(os.Stdin).ReadString('\n')
}
func run() error {
	if !supportedWindows() {
		return errors.New("Windows 10 build 19041 (2004) or newer is required")
	}
	dpi := user32.NewProc("SetProcessDpiAwarenessContext")
	if dpi.Find() != nil {
		return errors.New("per-monitor DPI support unavailable")
	}
	if r, _, _ := dpi.Call(^uintptr(3)); r == 0 {
		return errors.New("cannot enable per-monitor DPI awareness")
	}
	displays := monitors()
	if len(displays) == 0 {
		return errors.New("no interactive display available")
	}
	selfTest := len(os.Args) > 1 && os.Args[1] == "--self-test"
	var endpoint, code string
	if selfTest {
		screen = displays[0]
	} else {
		fmt.Println("WebZoom Presenter Overlay / Windows x64")
		fmt.Println("Share an ENTIRE SCREEN in WebZoom, not a window or browser tab.")
		for i, m := range displays {
			b := m.Bounds
			fmt.Printf("%d: %s  %dx%d at (%d,%d), primary=%v\n", i+1, m.Name, b.Right-b.Left, b.Bottom-b.Top, b.Left, b.Top, m.Primary)
		}
		reader := bufio.NewReader(os.Stdin)
		fmt.Print("Select the SAME monitor you are sharing (number): ")
		line, _ := reader.ReadString('\n')
		var choice int
		if _, err := fmt.Sscan(line, &choice); err != nil || choice < 1 || choice > len(displays) {
			return errors.New("invalid monitor selection")
		}
		screen = displays[choice-1]
		fmt.Println("Paste the short-lived pairing text from WebZoom here (do not share it):")
		line, err := readSecret(reader)
		if err != nil {
			return err
		}
		endpoint, code, err = overlayclient.ParsePairing(strings.TrimSpace(line))
		if err != nil {
			return err
		}
	}
	if err := createOverlay(); err != nil {
		stoppedReason = err
		return err
	}
	defer ucall("DestroyWindow", window)
	wts := syscall.NewLazyDLL("wtsapi32.dll")
	if ok, _, _ := wts.NewProc("WTSRegisterSessionNotification").Call(window, 0); ok == 0 {
		return errors.New("cannot monitor desktop session safety")
	}
	defer wts.NewProc("WTSUnRegisterSessionNotification").Call(window)
	if selfTest {
		// Exercise the actual native APIs without connecting or displaying user data.
		affinity := uint32(0)
		got := ucall("GetWindowDisplayAffinity", window, uintptr(unsafe.Pointer(&affinity)))
		styles := ucall("GetWindowLongPtrW", window, ^uintptr(19)) // GWL_EXSTYLE = -20
		if got == 0 || affinity != 0x11 || styles&0x080800a8 != 0x080800a8 {
			stoppedReason = errors.New("native overlay invariant failed")
			return stoppedReason
		}
		fmt.Printf("PASS: Windows build, per-monitor DPI, layered+click-through+topmost window, capture exclusion=0x%x; %d monitor(s).\n", affinity, len(displays))
		fmt.Println("This is an API smoke test, NOT proof that Chrome screen capture excludes the overlay.")
		return nil
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	go func() { <-ctx.Done(); ucall("PostMessageW", window, 0x10, 0, 0) }()
	go receive(ctx, endpoint, code)
	if ucall("RegisterHotKey", window, 1, 0x4007, 0x77) == 0 {
		return errors.New("Ctrl+Alt+Shift+F8 hotkey is unavailable")
	}
	defer ucall("UnregisterHotKey", window, 1)
	if ucall("RegisterHotKey", window, 2, 0x4007, 0x78) == 0 {
		return errors.New("Ctrl+Alt+Shift+F9 hotkey is unavailable")
	}
	defer ucall("UnregisterHotKey", window, 2)
	fmt.Println("Ctrl+Alt+Shift+F8: hide/show feedback. Ctrl+Alt+Shift+F9: disconnect.")
	fmt.Println("Keep this assistant running. Do not run it as administrator.")
	if ucall("SetTimer", window, 1, 33, 0) == 0 {
		return errors.New("cannot start safety timer")
	}
	defer ucall("KillTimer", window, 1)

	var msg message
	for {
		r := ucall("GetMessageW", uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if r == 0 {
			break
		}
		if int32(r) == -1 {
			return errors.New("window message loop failed")
		}
		ucall("TranslateMessage", uintptr(unsafe.Pointer(&msg)))
		ucall("DispatchMessageW", uintptr(unsafe.Pointer(&msg)))
	}
	return stoppedReason
}
func createOverlay() error {
	instance, _, _ := kernel32.NewProc("GetModuleHandleW").Call(0)
	name := text("WebZoomReadOnlyOverlay")
	wc := wndClass{Size: uint32(unsafe.Sizeof(wndClass{})), Proc: proc, Instance: instance, Name: name}
	if ucall("RegisterClassExW", uintptr(unsafe.Pointer(&wc))) == 0 {
		return errors.New("cannot register overlay window")
	}
	b := screen.Bounds
	// LAYERED | TRANSPARENT | TOPMOST | TOOLWINDOW | NOACTIVATE.
	window = ucall("CreateWindowExW", 0x080800a8, ptr(name), ptr(text("WebZoom feedback")), 0x80000000, uintptr(b.Left), uintptr(b.Top), uintptr(b.Right-b.Left), uintptr(b.Bottom-b.Top), 0, 0, instance, 0)
	if window == 0 {
		return errors.New("cannot create overlay window")
	}
	// Magenta is a color key. Input always passes through; no activation or focus.
	if ucall("SetLayeredWindowAttributes", window, 0xff00ff, 255, 1) == 0 {
		ucall("DestroyWindow", window)
		return errors.New("cannot make overlay transparent")
	}
	if ucall("SetWindowDisplayAffinity", window, 0x11) == 0 {
		ucall("DestroyWindow", window)
		return errors.New("capture exclusion unavailable; overlay disabled to avoid duplicate feedback")
	}
	return nil
}
func receive(ctx context.Context, endpoint, code string) {
	fail := func(err error) {
		select {
		case stopped <- err:
		default:
		}
	}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	dialCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	conn, _, err := websocket.Dial(dialCtx, endpoint, &websocket.DialOptions{HTTPClient: client, HTTPHeader: http.Header{"Authorization": []string{"Bearer " + code}}, CompressionMode: websocket.CompressionDisabled})
	cancel()
	if err != nil {
		fail(errors.New("connection failed: check pairing expiry, company CA trust, and server reachability"))
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1024 * 1024)
	read := func() ([]byte, error) {
		c, stop := context.WithTimeout(ctx, 4*time.Second)
		defer stop()
		typ, data, e := conn.Read(c)
		if e == nil && typ != websocket.MessageText {
			return nil, errors.New("unexpected video/binary data")
		}
		return data, e
	}
	raw, err := read()
	if err != nil {
		fail(errors.New("pairing handshake failed"))
		return
	}
	var hello struct {
		Type   string `json:"type"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
		Epoch  uint32 `json:"epoch"`
	}
	if json.Unmarshal(raw, &hello) != nil || hello.Type != "overlay-ready" || !overlayclient.Compatible(int(screen.Bounds.Right-screen.Bounds.Left), int(screen.Bounds.Bottom-screen.Bounds.Top), hello.Width, hello.Height) {
		fail(errors.New("capture and monitor dimensions differ; select the correct entire screen and pair again"))
		return
	}
	// Only the window thread mutates the model. The first internal event sets epoch.
	select {
	case incoming <- meeting.Event{Type: "overlay-initialize", Room: &meeting.Snapshot{Epoch: hello.Epoch}}:
	case <-ctx.Done():
		return
	}
	for {
		data, e := read()
		if e != nil {
			fail(errors.New("sharing ended, session expired, or connection lost; feedback cleared"))
			return
		}
		var ev meeting.Event
		if json.Unmarshal(data, &ev) != nil || (ev.Type != "annotations" && ev.Type != "annotation" && ev.Type != "overlay-heartbeat") {
			fail(errors.New("invalid server message"))
			return
		}
		select {
		case incoming <- ev:
		default:
			fail(errors.New("helper is too slow; feedback cleared, pair again"))
			return
		}
	}
}
func windowProc(hwnd uintptr, msg uint32, wparam, lparam uintptr) uintptr {
	switch msg {
	case 0x21:
		return 3 // MA_NOACTIVATE
	case 0x84:
		return ^uintptr(0) // HTTRANSPARENT
	case 0x14:
		return 1 // Buffered paint erases the background.
	case 0x113: // WM_TIMER
		select {
		case e := <-stopped:
			stoppedReason = e
			ucall("DestroyWindow", hwnd)
			return 0
		default:
		}
		dirty := false
		for i := 0; i < 64; i++ {
			select {
			case ev := <-incoming:
				if ev.Type == "annotation" || ev.Type == "annotations" {
					dirty = true
				}
				if ev.Type == "overlay-initialize" {
					model.Epoch = ev.Room.Epoch
					continue
				}
				if err := model.Apply(ev, time.Now()); err != nil {
					stoppedReason = err
					ucall("DestroyWindow", hwnd)
					return 0
				}
			default:
				i = 64
			}
		}
		before := len(model.Pointers)
		model.Prune(time.Now())
		dirty = dirty || before != len(model.Pointers)
		visible := model.Initialized && !paused
		if visible != shown {
			if visible {
				ucall("ShowWindow", hwnd, 4)
				dirty = true
			} else {
				ucall("ShowWindow", hwnd, 0)
			}
			shown = visible
		}
		if visible && dirty {
			ucall("InvalidateRect", hwnd, 0, 0)
		}
		return 0
	case 0x312: // WM_HOTKEY
		if wparam == 1 {
			paused = !paused
			if paused {
				ucall("ShowWindow", hwnd, 0)
				shown = false
			}
		} else if wparam == 2 {
			ucall("DestroyWindow", hwnd)
		}
		return 0
	case 0x7e, 0x2e0: // Display topology/DPI change: fail closed, never misplace marks.
		stoppedReason = errors.New("display layout or DPI changed; select the screen and pair again")
		ucall("DestroyWindow", hwnd)
		return 0
	case 0x2b1: // WM_WTSSESSION_CHANGE: never retain feedback across a locked/disconnected desktop.
		if wparam == 2 || wparam == 4 || wparam == 6 || wparam == 7 {
			ucall("DestroyWindow", hwnd)
		}
		return 0
	case 0x218: // Suspend/resume can change the capture surface.
		if wparam == 4 {
			ucall("DestroyWindow", hwnd)
		}
		return 1
	case 0xf:
		paint(hwnd)
		return 0
	case 0x10:
		ucall("DestroyWindow", hwnd)
		return 0
	case 2:
		model.Clear()
		ucall("PostQuitMessage", 0)
		return 0
	}
	return ucall("DefWindowProcW", hwnd, uintptr(msg), wparam, lparam)
}

// readSecret disables console echo so a shared entire screen cannot disclose the
// single-use capability while it is pasted. Never accept pairing through argv.
func readSecret(reader *bufio.Reader) (string, error) {
	handle, _, _ := kernel32.NewProc("GetStdHandle").Call(^uintptr(9)) // STD_INPUT_HANDLE=-10
	var mode uint32
	if ok, _, _ := kernel32.NewProc("GetConsoleMode").Call(handle, uintptr(unsafe.Pointer(&mode))); ok == 0 {
		return "", errors.New("pairing requires an interactive console")
	}
	if ok, _, _ := kernel32.NewProc("SetConsoleMode").Call(handle, uintptr(mode&^4)); ok == 0 {
		return "", errors.New("cannot hide pairing input")
	}
	defer kernel32.NewProc("SetConsoleMode").Call(handle, uintptr(mode))
	line, err := reader.ReadString('\n')
	fmt.Println()
	return line, err
}
func rgb(s string) uintptr {
	if len(s) != 7 || s[0] != '#' {
		return 0
	}
	n, err := strconv.ParseUint(s[1:], 16, 32)
	if err != nil {
		return 0
	}
	return uintptr((n>>16)&255 | (n & 0xff00) | (n&255)<<16)
}
func paint(hwnd uintptr) {
	var ps paintStruct
	dc := ucall("BeginPaint", hwnd, uintptr(unsafe.Pointer(&ps)))
	if dc == 0 {
		return
	}
	defer ucall("EndPaint", hwnd, uintptr(unsafe.Pointer(&ps)))
	w, h := int32(screen.Bounds.Right-screen.Bounds.Left), int32(screen.Bounds.Bottom-screen.Bounds.Top)
	mem := gcall("CreateCompatibleDC", dc)
	if mem == 0 {
		return
	}
	defer gcall("DeleteDC", mem)
	bitmap := gcall("CreateCompatibleBitmap", dc, uintptr(w), uintptr(h))
	if bitmap == 0 {
		return
	}
	defer gcall("DeleteObject", bitmap)
	old := gcall("SelectObject", mem, bitmap)
	defer gcall("SelectObject", mem, old)
	paintScene(mem, w, h, &model)
	gcall("BitBlt", dc, 0, 0, uintptr(w), uintptr(h), mem, 0, 0, 0x00cc0020)
}

// paintScene renders only supplied annotation data, never reads desktop pixels.
func paintScene(mem uintptr, w, h int32, state *overlayclient.Model) {
	background := gcall("CreateSolidBrush", 0xff00ff)
	bounds := rect{0, 0, w, h}
	ucall("FillRect", mem, uintptr(unsafe.Pointer(&bounds)), background)
	gcall("DeleteObject", background)
	draw := func(points []point, color string) {
		if len(points) == 0 {
			return
		}
		pen := gcall("CreatePen", 0, 3, rgb(color))
		prior := gcall("SelectObject", mem, pen)
		if len(points) == 1 {
			p := points[0]
			points = []point{{p.X - 1, p.Y}, {p.X + 1, p.Y}}
		}
		gcall("Polyline", mem, uintptr(unsafe.Pointer(&points[0])), uintptr(len(points)))
		gcall("SelectObject", mem, prior)
		gcall("DeleteObject", pen)
	}
	for _, stroke := range state.Strokes {
		points := make([]point, len(stroke.Points))
		for i, p := range stroke.Points {
			points[i] = point{int32(p.X * float64(w-1)), int32(p.Y * float64(h-1))}
		}
		draw(points, stroke.Color)
	}
	gcall("SetBkMode", mem, 1)
	for _, p := range state.Pointers {
		x, y := int32(p.Point.X*float64(w-1)), int32(p.Point.Y*float64(h-1))
		draw([]point{{x + 15, y + 15}, {x, y}, {x + 2, y + 12}, {x, y}, {x + 12, y + 2}}, p.Color)
		label := []rune(p.User.Name)
		if len(label) > 24 {
			label = label[:24]
		}
		u := utf16.Encode(label)
		if len(u) > 0 {
			gcall("SetTextColor", mem, rgb(p.Color))
			gcall("TextOutW", mem, uintptr(x+16), uintptr(y+16), uintptr(unsafe.Pointer(&u[0])), uintptr(len(u)))
		}
	}
}
