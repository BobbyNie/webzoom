package overlayclient

import (
	"strings"
	"testing"
	"time"
	"webzoom/internal/meeting"
)

func TestPairingRejectsUnsafeOrigins(t *testing.T) {
	code := strings.Repeat("a", 43)
	endpoint, token, err := ParsePairing("https://meeting.example/#webzoom-overlay=" + code)
	if err != nil || token != code || endpoint != "wss://meeting.example/api/overlay/ws" {
		t.Fatal(endpoint, err)
	}
	for _, input := range []string{"http://meeting.example/#webzoom-overlay=" + code, "https://user:secret@meeting.example/#webzoom-overlay=" + code, "https://meeting.example/path#webzoom-overlay=" + code, "https://meeting.example/?token=x#webzoom-overlay=" + code, "https://meeting.example/#webzoom-overlay=short", "https://meeting.example/?#webzoom-overlay=" + code} {
		if _, _, err := ParsePairing(input); err == nil {
			t.Fatal("unsafe input accepted", input)
		}
	}
}
func TestCaptureGeometry(t *testing.T) {
	if !Compatible(3840, 2160, 1920, 1080) || !Compatible(1920, 1080, 1920, 1080) || Compatible(1920, 1080, 1080, 1920) || Compatible(1920, 1080, 0, 0) {
		t.Fatal("invalid capture mapping")
	}
}
func TestAnnotationReplayAndExpiry(t *testing.T) {
	now := time.Now()
	m := Model{Epoch: 2}
	u := meeting.User{ID: "u", Name: "User"}
	if err := m.Apply(meeting.Event{Type: "annotations", Annotations: &meeting.AnnotationState{Epoch: 2}}, now); err != nil {
		t.Fatal(err)
	}
	e := meeting.AnnotationEvent{Kind: "draw", Epoch: 2, User: u, StrokeID: "s", Color: "#e53935", Points: []meeting.Point{{X: .5, Y: .5}}}
	if err := m.Apply(meeting.Event{Type: "annotation", Annotation: &e}, now); err != nil {
		t.Fatal(err)
	}
	e.Segment = 1
	if err := m.Apply(meeting.Event{Type: "annotation", Annotation: &e}, now); err != nil {
		t.Fatal(err)
	}
	if len(m.Strokes) != 1 || len(m.Strokes[0].Points) != 2 {
		t.Fatal(m)
	}
	e.Kind = "pointer"
	if err := m.Apply(meeting.Event{Type: "annotation", Annotation: &e}, now); err != nil {
		t.Fatal(err)
	}
	m.Prune(now.Add(2 * time.Second))
	if len(m.Pointers) != 0 {
		t.Fatal("stale pointer")
	}
	e.Kind = "clear-own"
	e.Generation = 1
	e.Points = nil
	if err := m.Apply(meeting.Event{Type: "annotation", Annotation: &e}, now); err != nil || len(m.Strokes) != 0 {
		t.Fatal(m, err)
	}
	e.Kind = "draw"
	e.Generation = 0
	e.Points = []meeting.Point{{X: .5, Y: .5}}
	if err := m.Apply(meeting.Event{Type: "annotation", Annotation: &e}, now); err == nil {
		t.Fatal("stale generation accepted")
	}
	m.Clear()
	if m.Initialized || len(m.Strokes) != 0 {
		t.Fatal("disconnect didn't clear")
	}
}
func TestInvalidAnnotationFailsClosed(t *testing.T) {
	for _, p := range []meeting.Point{{X: -1}, {X: 1.5}, {Y: 2}} {
		m := Model{Epoch: 1}
		err := m.Apply(meeting.Event{Type: "annotations", Annotations: &meeting.AnnotationState{Epoch: 1, Strokes: []meeting.Stroke{{Color: "#e53935", Points: []meeting.Point{p}}}}}, time.Now())
		if err == nil {
			t.Fatal("invalid point accepted")
		}
	}
}
