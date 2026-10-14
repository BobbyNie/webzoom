package meeting

import (
	"math"
	"regexp"
	"time"
)

// Persistent strokes are bounded independently of the media queues.
const maxAnnotationStrokes = 128
const maxAnnotationPoints = 8192
const maxStrokePoints = 512

var strokeIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
var annotationColors = map[string]bool{"#e53935": true, "#2563eb": true, "#16a34a": true, "#f59e0b": true}

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type Stroke struct {
	ID      string  `json:"id"`
	User    User    `json:"user"`
	Color   string  `json:"color"`
	Points  []Point `json:"points"`
	Segment int     `json:"segment"`
}
type AnnotationState struct {
	Epoch      uint32   `json:"epoch"`
	Generation uint32   `json:"generation"`
	Strokes    []Stroke `json:"strokes"`
}
type AnnotationCommand struct {
	Kind       string  `json:"kind"`
	Epoch      uint32  `json:"epoch"`
	Generation uint32  `json:"generation"`
	StrokeID   string  `json:"strokeId,omitempty"`
	Segment    int     `json:"segment,omitempty"`
	Color      string  `json:"color,omitempty"`
	Points     []Point `json:"points,omitempty"`
}
type AnnotationEvent struct {
	Kind       string  `json:"kind"`
	Epoch      uint32  `json:"epoch"`
	Generation uint32  `json:"generation"`
	User       User    `json:"user"`
	StrokeID   string  `json:"strokeId,omitempty"`
	Segment    int     `json:"segment"`
	Color      string  `json:"color,omitempty"`
	Points     []Point `json:"points,omitempty"`
}
type annotationRoom struct {
	generation uint32
	strokes    []Stroke
	points     int
	window     time.Time
	messages   int
}

func annotationSnapshot(r *room) *AnnotationState {
	s := &AnnotationState{Epoch: r.Epoch, Generation: r.annotations.generation, Strokes: make([]Stroke, len(r.annotations.strokes))}
	for i, stroke := range r.annotations.strokes {
		s.Strokes[i] = stroke
		s.Strokes[i].Points = append([]Point(nil), stroke.Points...)
	}
	return s
}
func (h *Hub) broadcastAnnotations(r *room) {
	state := annotationSnapshot(r)
	for _, p := range r.peers {
		h.emit(p, Event{Type: "annotations", Annotations: state})
	}
}
func (h *Hub) annotationBroadcast(r *room, e AnnotationEvent) {
	for _, p := range r.peers {
		if e.Kind == "pointer" {
			// Pointers are ephemeral: never disconnect a slow video viewer for a pointer.
			if len(p.Events) >= 8 {
				continue
			}
			select {
			case <-p.Done:
				continue
			default:
			}
			select {
			case p.Events <- Event{Type: "annotation", Annotation: &e}:
			default:
			}
		} else {
			h.emit(p, Event{Type: "annotation", Annotation: &e})
		}
	}
}
func validPoint(p Point) bool {
	return !math.IsNaN(p.X) && !math.IsNaN(p.Y) && !math.IsInf(p.X, 0) && !math.IsInf(p.Y, 0) && p.X >= 0 && p.X <= 1 && p.Y >= 0 && p.Y <= 1
}
func (h *Hub) Annotate(p *Peer, c AnnotationCommand) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, err := h.room(p.RoomID)
	if err != nil {
		return err
	}
	if r.peers[p.User.ID] != p {
		return ErrForbidden
	}
	select {
	case <-p.Done:
		return ErrForbidden
	default:
	}
	if p.User.ID != r.OwnerID && !r.annotators[p.User.ID] {
		return ErrForbidden
	}
	if !r.Active || c.Epoch != r.Epoch || c.Generation != r.annotations.generation {
		return ErrConflict
	}
	if len(c.Points) > 32 {
		return ErrConflict
	}
	for _, point := range c.Points {
		if !validPoint(point) {
			return ErrConflict
		}
	}
	e := AnnotationEvent{Kind: c.Kind, Epoch: r.Epoch, Generation: r.annotations.generation, User: p.User, StrokeID: c.StrokeID, Segment: c.Segment, Color: c.Color, Points: append([]Point(nil), c.Points...)}
	switch c.Kind {
	case "draw":
		if !strokeIDPattern.MatchString(c.StrokeID) || !annotationColors[c.Color] || len(c.Points) == 0 || c.Segment < 0 {
			return ErrConflict
		}
		index := -1
		for i, stroke := range r.annotations.strokes {
			if stroke.ID == c.StrokeID && stroke.User.ID == p.User.ID {
				index = i
				break
			}
		}
		if index < 0 {
			if c.Segment != 0 {
				return ErrConflict
			}
			if len(r.annotations.strokes) >= maxAnnotationStrokes {
				return ErrCapacity
			}
		} else {
			stroke := r.annotations.strokes[index]
			if c.Segment != stroke.Segment+1 || c.Color != stroke.Color {
				return ErrConflict
			}
			if len(stroke.Points)+len(c.Points) > maxStrokePoints {
				return ErrCapacity
			}
		}
		if r.annotations.points+len(c.Points) > maxAnnotationPoints {
			return ErrCapacity
		}
		if !annotationBudget(r, h.cfg.Now()) {
			return ErrCapacity
		}
		if index < 0 {
			r.annotations.strokes = append(r.annotations.strokes, Stroke{ID: c.StrokeID, User: p.User, Color: c.Color, Points: append([]Point(nil), c.Points...), Segment: c.Segment})
		} else {
			stroke := &r.annotations.strokes[index]
			stroke.Points = append(stroke.Points, c.Points...)
			stroke.Segment = c.Segment
		}
		r.annotations.points += len(c.Points)
	case "pointer":
		if len(c.Points) > 1 || (c.Color != "" && !annotationColors[c.Color]) {
			return ErrConflict
		}
		if !annotationBudget(r, h.cfg.Now()) {
			return nil
		} // Coalesced/lossy by design.
	case "clear-all", "clear-own":
		if len(c.Points) != 0 {
			return ErrConflict
		}
		if c.Kind == "clear-all" && p.User.ID != r.OwnerID {
			return ErrForbidden
		}
		if !annotationBudget(r, h.cfg.Now()) {
			return ErrCapacity
		}
		kept := make([]Stroke, 0)
		points := 0
		if c.Kind == "clear-own" {
			for _, stroke := range r.annotations.strokes {
				if stroke.User.ID != p.User.ID {
					kept = append(kept, stroke)
					points += len(stroke.Points)
				}
			}
		}
		r.annotations.strokes = kept
		r.annotations.points = points
		r.annotations.generation++
		e.Generation = r.annotations.generation
	default:
		return ErrConflict
	}
	h.annotationBroadcast(r, e)
	return nil
}
func annotationBudget(r *room, now time.Time) bool {
	if r.annotations.window.IsZero() || now.Sub(r.annotations.window) >= time.Second {
		r.annotations.window = now
		r.annotations.messages = 0
	}
	if r.annotations.messages >= 60 {
		return false
	}
	r.annotations.messages++
	return true
}
func (h *Hub) RejectAnnotation(p *Peer, reason string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rooms[p.RoomID]; r != nil && r.peers[p.User.ID] == p {
		h.emit(p, Event{Type: "annotation-error", Error: reason})
	}
}
