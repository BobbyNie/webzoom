// Package overlayclient contains the portable, testable read-only helper protocol.
package overlayclient

import (
	"errors"
	"math"
	"net/url"
	"regexp"
	"time"
	"webzoom/internal/meeting"
)

var codePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)

// ParsePairing never accepts credentials in URLs, cleartext HTTP, paths, or query
// strings. A fragment is copied from the authenticated web UI, never navigated to.
func ParsePairing(input string) (endpoint, code string, err error) {
	u, e := url.Parse(input)
	if e != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.ForceQuery || (u.Path != "" && u.Path != "/") {
		return "", "", errors.New("use the HTTPS pairing text from WebZoom")
	}
	const prefix = "webzoom-overlay="
	if len(u.Fragment) <= len(prefix) || u.Fragment[:len(prefix)] != prefix || !codePattern.MatchString(u.Fragment[len(prefix):]) {
		return "", "", errors.New("invalid pairing text")
	}
	code = u.Fragment[len(prefix):]
	u.Fragment = ""
	u.RawFragment = ""
	u.Scheme = "wss"
	u.Path = "/api/overlay/ws"
	return u.String(), code, nil
}

// Browser capture can be downscaled, but it must retain the chosen monitor's
// aspect ratio. Identical monitors still require explicit user selection.
func Compatible(width, height, captureWidth, captureHeight int) bool {
	if width < 100 || height < 100 || captureWidth < 100 || captureHeight < 100 {
		return false
	}
	return math.Abs(float64(width)/float64(height)-float64(captureWidth)/float64(captureHeight))/(float64(width)/float64(height)) < .01
}

type Pointer struct {
	User  meeting.User
	Color string
	Point meeting.Point
	Seen  time.Time
}
type Model struct {
	Epoch, Generation uint32
	Strokes           []meeting.Stroke
	Pointers          map[string]Pointer
	Initialized       bool
}

func (m *Model) Clear() { m.Strokes = nil; m.Pointers = map[string]Pointer{}; m.Initialized = false }
func validPoints(points []meeting.Point) bool {
	for _, p := range points {
		if math.IsNaN(p.X) || math.IsNaN(p.Y) || math.IsInf(p.X, 0) || math.IsInf(p.Y, 0) || p.X < 0 || p.X > 1 || p.Y < 0 || p.Y > 1 {
			return false
		}
	}
	return true
}
func validColor(color string) bool {
	return color == "#e53935" || color == "#2563eb" || color == "#16a34a" || color == "#f59e0b"
}
func (m *Model) Apply(ev meeting.Event, now time.Time) error {
	invalid := errors.New("invalid overlay state; pair again")
	if ev.Type == "annotations" {
		s := ev.Annotations
		if s == nil || s.Epoch != m.Epoch || len(s.Strokes) > 128 {
			return invalid
		}
		total := 0
		for _, stroke := range s.Strokes {
			total += len(stroke.Points)
			if len(stroke.Points) > 512 || !validPoints(stroke.Points) || !validColor(stroke.Color) {
				return invalid
			}
		}
		if total > 8192 {
			return invalid
		}
		m.Strokes = s.Strokes
		m.Generation = s.Generation
		m.Pointers = map[string]Pointer{}
		m.Initialized = true
		return nil
	}
	if ev.Type != "annotation" {
		return nil
	}
	e := ev.Annotation
	if e == nil || e.Epoch != m.Epoch || !m.Initialized || !validPoints(e.Points) {
		return invalid
	}
	if e.Kind == "clear-all" || e.Kind == "clear-own" {
		if e.Generation != m.Generation+1 {
			return invalid
		}
		kept := make([]meeting.Stroke, 0)
		if e.Kind == "clear-own" {
			for _, s := range m.Strokes {
				if s.User.ID != e.User.ID {
					kept = append(kept, s)
				}
			}
		}
		m.Strokes = kept
		m.Generation = e.Generation
		m.Pointers = map[string]Pointer{}
		return nil
	}
	if e.Generation != m.Generation {
		return invalid
	}
	switch e.Kind {
	case "pointer":
		if len(e.Points) > 1 {
			return invalid
		}
		if len(e.Points) == 0 {
			delete(m.Pointers, e.User.ID)
			return nil
		}
		if !validColor(e.Color) {
			return invalid
		}
		m.Prune(now)
		if len(m.Pointers) >= 256 {
			if _, ok := m.Pointers[e.User.ID]; !ok {
				return nil
			}
		}
		m.Pointers[e.User.ID] = Pointer{e.User, e.Color, e.Points[0], now}
	case "draw":
		if !validColor(e.Color) || len(e.Points) == 0 || len(e.Points) > 32 {
			return invalid
		}
		count := len(e.Points)
		index := -1
		for i, s := range m.Strokes {
			count += len(s.Points)
			if s.ID == e.StrokeID && s.User.ID == e.User.ID {
				index = i
			}
		}
		if count > 8192 {
			return invalid
		}
		if index < 0 {
			if e.Segment != 0 || len(m.Strokes) >= 128 {
				return invalid
			}
			m.Strokes = append(m.Strokes, meeting.Stroke{ID: e.StrokeID, User: e.User, Color: e.Color, Points: e.Points, Segment: e.Segment})
		} else {
			s := &m.Strokes[index]
			if e.Segment != s.Segment+1 || s.Color != e.Color || len(s.Points)+len(e.Points) > 512 {
				return invalid
			}
			s.Points = append(s.Points, e.Points...)
			s.Segment = e.Segment
		}
	default:
		return invalid
	}
	return nil
}
func (m *Model) Prune(now time.Time) {
	for id, p := range m.Pointers {
		if now.Sub(p.Seen) >= 1800*time.Millisecond {
			delete(m.Pointers, id)
		}
	}
}
