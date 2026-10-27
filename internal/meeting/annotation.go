package meeting

import (
	"math"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// Persistent strokes are bounded independently of the media queues.
const maxAnnotationStrokes = 128
const maxAnnotationPoints = 8192
const maxStrokePoints = 512

var strokeIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
var annotationColors = map[string]bool{"#e53935": true, "#2563eb": true, "#16a34a": true, "#f59e0b": true, "#7c3aed": true, "#ec4899": true, "#ffffff": true, "#111827": true}

type Point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Style is validated by the server; legacy clients keep the default pen/3px.
type AnnotationStyle struct {
	Tool  string  `json:"tool,omitempty"`
	Width float64 `json:"width,omitempty"`
	Text  string  `json:"text,omitempty"`
}
type AnnotationHistory struct {
	Undo int `json:"undo"`
	Redo int `json:"redo"`
}
type annotationChange struct {
	Actor, User, ID string
	Before, After   bool
}
type Stroke struct {
	AnnotationStyle
	ExpiresAt int64   `json:"expiresAt,omitempty"`
	Hidden    bool    `json:"-"`
	ID        string  `json:"id"`
	User      User    `json:"user"`
	Color     string  `json:"color"`
	Points    []Point `json:"points"`
	Segment   int     `json:"segment"`
}
type AnnotationState struct {
	History    map[string]AnnotationHistory `json:"history,omitempty"`
	Epoch      uint32                       `json:"epoch"`
	Generation uint32                       `json:"generation"`
	Strokes    []Stroke                     `json:"strokes"`
}
type AnnotationCommand struct {
	AnnotationStyle
	Kind       string  `json:"kind"`
	Epoch      uint32  `json:"epoch"`
	Generation uint32  `json:"generation"`
	StrokeID   string  `json:"strokeId,omitempty"`
	Segment    int     `json:"segment,omitempty"`
	Color      string  `json:"color,omitempty"`
	Points     []Point `json:"points,omitempty"`
}
type AnnotationEvent struct {
	AnnotationStyle
	ExpiresAt  int64              `json:"expiresAt,omitempty"`
	History    *AnnotationHistory `json:"history,omitempty"`
	Kind       string             `json:"kind"`
	Epoch      uint32             `json:"epoch"`
	Generation uint32             `json:"generation"`
	User       User               `json:"user"`
	StrokeID   string             `json:"strokeId,omitempty"`
	Segment    int                `json:"segment"`
	Color      string             `json:"color,omitempty"`
	Points     []Point            `json:"points,omitempty"`
}
type annotationRoom struct {
	undo, redo []annotationChange
	generation uint32
	strokes    []Stroke
	points     int
	window     time.Time
	messages   int
}

func annotationHistory(r *room, user string) AnnotationHistory {
	var result AnnotationHistory
	for _, c := range r.annotations.undo {
		if c.Actor == user {
			result.Undo++
		}
	}
	for _, c := range r.annotations.redo {
		if c.Actor == user {
			result.Redo++
		}
	}
	return result
}
func annotationSnapshot(r *room) *AnnotationState {
	s := &AnnotationState{Epoch: r.Epoch, Generation: r.annotations.generation, Strokes: make([]Stroke, 0), History: map[string]AnnotationHistory{}}
	for _, stroke := range r.annotations.strokes {
		if stroke.Hidden {
			continue
		}
		copy := stroke
		copy.Points = append([]Point(nil), stroke.Points...)
		s.Strokes = append(s.Strokes, copy)
	}
	for _, c := range append(append([]annotationChange{}, r.annotations.undo...), r.annotations.redo...) {
		s.History[c.Actor] = annotationHistory(r, c.Actor)
	}
	return s
}

// All history storage, including erased/undone objects, shares the room's bounds.
func recordAnnotationChange(r *room, c annotationChange) {
	redo := r.annotations.redo[:0]
	for _, item := range r.annotations.redo {
		if item.Actor != c.Actor {
			redo = append(redo, item)
		}
	}
	r.annotations.redo = redo
	r.annotations.undo = append(r.annotations.undo, c)
	if len(r.annotations.undo) > 128 {
		r.annotations.undo = r.annotations.undo[len(r.annotations.undo)-128:]
	}
}
func pruneAnnotations(r *room, now time.Time) {
	kept := r.annotations.strokes[:0]
	points := 0
	for _, s := range r.annotations.strokes {
		if s.ExpiresAt > 0 && s.ExpiresAt <= now.UnixMilli() {
			continue
		}
		referenced := !s.Hidden
		for _, list := range [][]annotationChange{r.annotations.undo, r.annotations.redo} {
			for _, c := range list {
				if c.ID == s.ID && c.User == s.User.ID {
					referenced = true
				}
			}
		}
		if referenced {
			kept = append(kept, s)
			points += len(s.Points)
		}
	}
	r.annotations.strokes = kept
	r.annotations.points = points
	for _, list := range []*[]annotationChange{&r.annotations.undo, &r.annotations.redo} {
		filtered := (*list)[:0]
		for _, c := range *list {
			for _, s := range kept {
				if c.ID == s.ID && c.User == s.User.ID {
					filtered = append(filtered, c)
					break
				}
			}
		}
		*list = filtered
	}
}
func validAnnotationStyle(c AnnotationCommand) bool {
	switch c.Tool {
	case "", "pen", "highlighter", "temporary", "line", "arrow", "rectangle", "ellipse", "text":
	default:
		return false
	}
	if c.Width != 0 && c.Width != 2 && c.Width != 3 && c.Width != 6 && c.Width != 10 {
		return false
	}
	if c.Tool == "text" {
		return c.Segment == 0 && len(c.Points) == 1 && utf8.ValidString(c.Text) && utf8.RuneCountInString(c.Text) <= 160 && strings.TrimSpace(c.Text) != "" && !strings.ContainsAny(c.Text, "\n\r\x00")
	}
	if c.Text != "" {
		return false
	}
	if c.Tool == "line" || c.Tool == "arrow" || c.Tool == "rectangle" || c.Tool == "ellipse" {
		return c.Segment == 0 && len(c.Points) == 2
	}
	return true
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
	pruneAnnotations(r, h.cfg.Now())
	e := AnnotationEvent{AnnotationStyle: c.AnnotationStyle, Kind: c.Kind, Epoch: r.Epoch, Generation: r.annotations.generation, User: p.User, StrokeID: c.StrokeID, Segment: c.Segment, Color: c.Color, Points: append([]Point(nil), c.Points...)}
	switch c.Kind {
	case "draw":
		if !validAnnotationStyle(c) || !strokeIDPattern.MatchString(c.StrokeID) || !annotationColors[c.Color] || len(c.Points) == 0 || c.Segment < 0 {
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
			if stroke.Hidden || c.Tool == "text" || c.Tool == "line" || c.Tool == "arrow" || c.Tool == "rectangle" || c.Tool == "ellipse" || c.Segment != stroke.Segment+1 || c.Color != stroke.Color || c.AnnotationStyle != stroke.AnnotationStyle {
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
			expires := int64(0)
			if c.Tool == "temporary" {
				expires = h.cfg.Now().Add(5 * time.Second).UnixMilli()
			}
			e.ExpiresAt = expires
			recordAnnotationChange(r, annotationChange{Actor: p.User.ID, User: p.User.ID, ID: c.StrokeID, Before: true, After: false})
			r.annotations.strokes = append(r.annotations.strokes, Stroke{AnnotationStyle: c.AnnotationStyle, ExpiresAt: expires, ID: c.StrokeID, User: p.User, Color: c.Color, Points: append([]Point(nil), c.Points...), Segment: c.Segment})
		} else {
			stroke := &r.annotations.strokes[index]
			e.ExpiresAt = stroke.ExpiresAt
			stroke.Points = append(stroke.Points, c.Points...)
			stroke.Segment = c.Segment
		}
		r.annotations.points += len(c.Points)
	case "undo", "redo", "erase":
		if len(c.Points) != 0 {
			return ErrConflict
		}
		if !annotationBudget(r, h.cfg.Now()) {
			return ErrCapacity
		}
		var change annotationChange
		if c.Kind == "erase" {
			found := false
			for _, s := range r.annotations.strokes {
				if s.ID == c.StrokeID && s.User.ID == p.User.ID && !s.Hidden {
					change = annotationChange{Actor: p.User.ID, User: p.User.ID, ID: s.ID, Before: false, After: true}
					found = true
					break
				}
			}
			if !found {
				return ErrConflict
			}
			recordAnnotationChange(r, change)
		} else {
			source, dest := &r.annotations.undo, &r.annotations.redo
			if c.Kind == "redo" {
				source, dest = dest, source
			}
			index := -1
			for i := len(*source) - 1; i >= 0; i-- {
				if (*source)[i].Actor == p.User.ID {
					index = i
					break
				}
			}
			if index < 0 {
				h.broadcastAnnotations(r) // Expired temporary ink can remove the last history entry.
				return nil
			}
			change = (*source)[index]
			*source = append((*source)[:index], (*source)[index+1:]...)
			*dest = append(*dest, change)
		}
		hidden := change.After
		if c.Kind == "undo" {
			hidden = change.Before
		}
		for i := range r.annotations.strokes {
			s := &r.annotations.strokes[i]
			if s.ID == change.ID && s.User.ID == change.User {
				s.Hidden = hidden
			}
		}
		r.annotations.generation++ // Fence late segments from before this edit.
		h.broadcastAnnotations(r)
		return nil
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
		if c.Kind == "clear-all" {
			r.annotations.undo = nil
			r.annotations.redo = nil
		} else {
			for _, list := range []*[]annotationChange{&r.annotations.undo, &r.annotations.redo} {
				keptHistory := (*list)[:0]
				for _, change := range *list {
					if change.Actor != p.User.ID {
						keptHistory = append(keptHistory, change)
					}
				}
				*list = keptHistory
			}
		}
		r.annotations.strokes = kept
		r.annotations.points = points
		r.annotations.generation++
		e.Generation = r.annotations.generation
	default:
		return ErrConflict
	}
	history := annotationHistory(r, p.User.ID)
	e.History = &history
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
