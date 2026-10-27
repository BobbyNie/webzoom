package meeting

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func toolCommand(t *testing.T, h *Hub, s Snapshot, p *Peer, kind, id string) {
	t.Helper()
	if err := h.Annotate(p, AnnotationCommand{Kind: kind, Epoch: s.Epoch, Generation: h.rooms[s.ID].annotations.generation, StrokeID: id}); err != nil {
		t.Fatalf("%s: %v", kind, err)
	}
}
func TestAnnotationNewToolValidationAndReplay(t *testing.T) {
	for _, tool := range []string{"pen", "highlighter", "temporary", "line", "arrow", "rectangle", "ellipse", "text"} {
		t.Run(tool, func(t *testing.T) {
			h, s, owner, _ := annotationFixture(t)
			c := drawFor(s, 0)
			c.Tool = tool
			c.Width = 6
			c.Color = "#7c3aed"
			if tool == "text" {
				c.Points = c.Points[:1]
				c.Text = "<script>你好</script>"
			}
			if err := h.Annotate(owner, c); err != nil {
				t.Fatal(err)
			}
			replay := annotationSnapshot(h.rooms[s.ID])
			if len(replay.Strokes) != 1 || replay.Strokes[0].AnnotationStyle != c.AnnotationStyle || replay.History[owner.User.ID].Undo != 1 {
				t.Fatal(replay)
			}
			if tool == "temporary" && replay.Strokes[0].ExpiresAt == 0 {
				t.Fatal("missing expiry")
			}
			replay.Strokes[0].Points[0].X = .99
			if h.rooms[s.ID].annotations.strokes[0].Points[0].X == .99 {
				t.Fatal("snapshot aliases internal points")
			}
		})
	}
	for _, style := range []AnnotationStyle{{Tool: "javascript"}, {Tool: "pen", Width: 99}, {Tool: "text", Text: ""}, {Tool: "text", Text: strings.Repeat("字", 161)}, {Tool: "text", Text: "line\nline"}, {Tool: "pen", Text: "hidden text"}} {
		h, s, p, _ := annotationFixture(t)
		c := drawFor(s, 0)
		c.AnnotationStyle = style
		if err := h.Annotate(p, c); !errors.Is(err, ErrConflict) {
			t.Fatalf("accepted invalid style %#v: %v", style, err)
		}
	}
	h, s, p, _ := annotationFixture(t)
	c := drawFor(s, 0)
	c.Tool = "rectangle"
	c.Points = c.Points[:1]
	if err := h.Annotate(p, c); !errors.Is(err, ErrConflict) {
		t.Fatal("partial shape accepted", err)
	}
}
func TestAnnotationUndoRedoEraseOwnershipAndGeneration(t *testing.T) {
	h, s, owner, guest := annotationFixture(t)
	h.Action(s.ID, "owner", "annotation-grant", "guest")
	c := drawFor(s, 0)
	if err := h.Annotate(owner, c); err != nil {
		t.Fatal(err)
	}
	c.StrokeID = "guest-ink"
	if err := h.Annotate(guest, c); err != nil {
		t.Fatal(err)
	}
	if err := h.Annotate(guest, AnnotationCommand{Kind: "erase", Epoch: s.Epoch, StrokeID: "stroke-1"}); !errors.Is(err, ErrConflict) {
		t.Fatal("erased someone else", err)
	}
	toolCommand(t, h, s, guest, "undo", "")
	snapshot := annotationSnapshot(h.rooms[s.ID])
	if len(snapshot.Strokes) != 1 || snapshot.Strokes[0].User.ID != "owner" || snapshot.History["guest"].Redo != 1 {
		t.Fatal(snapshot)
	}
	c.Segment = 1
	if err := h.Annotate(guest, c); !errors.Is(err, ErrConflict) {
		t.Fatal("late segment crossed undo generation", err)
	}
	toolCommand(t, h, s, guest, "redo", "")
	toolCommand(t, h, s, guest, "erase", "guest-ink")
	if len(annotationSnapshot(h.rooms[s.ID]).Strokes) != 1 {
		t.Fatal("erase not applied")
	}
	toolCommand(t, h, s, guest, "undo", "")
	if len(annotationSnapshot(h.rooms[s.ID]).Strokes) != 2 {
		t.Fatal("erase not undoable")
	}
	toolCommand(t, h, s, guest, "clear-own", "")
	snapshot = annotationSnapshot(h.rooms[s.ID])
	if len(snapshot.Strokes) != 1 || snapshot.History["owner"].Undo != 1 {
		t.Fatal("own clear damaged someone else's history", snapshot)
	}
	toolCommand(t, h, s, owner, "undo", "")
	if len(annotationSnapshot(h.rooms[s.ID]).Strokes) != 0 {
		t.Fatal("owner undo lost after guest clear")
	}
}
func TestAnnotationHistoryForkAndExpiration(t *testing.T) {
	h, s, owner, guest := annotationFixture(t)
	h.Action(s.ID, "owner", "annotation-grant", "guest")
	now := time.Now()
	h.cfg.Now = func() time.Time { return now }
	c := drawFor(s, 0)
	c.Tool = "temporary"
	if err := h.Annotate(owner, c); err != nil {
		t.Fatal(err)
	}
	toolCommand(t, h, s, owner, "undo", "")
	now = now.Add(6 * time.Second)
	toolCommand(t, h, s, owner, "redo", "")
	snapshot := annotationSnapshot(h.rooms[s.ID])
	if len(snapshot.Strokes) != 0 || snapshot.History["owner"].Redo != 0 || h.rooms[s.ID].annotations.points != 0 {
		t.Fatal("expired ink resurrected", snapshot)
	}
	for i, p := range []*Peer{owner, guest} {
		c = drawFor(s, h.rooms[s.ID].annotations.generation)
		c.StrokeID = fmt.Sprintf("ink-%d", i)
		if err := h.Annotate(p, c); err != nil {
			t.Fatal(err)
		}
	}
	toolCommand(t, h, s, owner, "undo", "")
	toolCommand(t, h, s, guest, "undo", "")
	c = drawFor(s, h.rooms[s.ID].annotations.generation)
	c.StrokeID = "new-owner"
	if err := h.Annotate(owner, c); err != nil {
		t.Fatal(err)
	}
	snapshot = annotationSnapshot(h.rooms[s.ID])
	if snapshot.History["owner"].Redo != 0 || snapshot.History["guest"].Redo != 1 {
		t.Fatal("redo fork not per actor", snapshot.History)
	}
}
func TestRevokeAllAnnotationsAlsoInvalidatesDisconnectedRecovery(t *testing.T) {
	h, s, owner, guest := annotationFixture(t)
	h.Action(s.ID, "owner", "annotation-grant", "guest")
	if _, err := h.Action(s.ID, "guest", "annotation-revoke-all", ""); !errors.Is(err, ErrForbidden) {
		t.Fatal("guest revoked all", err)
	}
	h.Disconnect(guest)
	if len(h.rooms[s.ID].reconnectGrants) == 0 {
		t.Fatal("fixture missing recovery")
	}
	if _, err := h.Action(s.ID, "owner", "annotation-revoke-all", ""); err != nil {
		t.Fatal(err)
	}
	reconnected, err := h.Join(s.ID, guest.User, guest.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err = h.Annotate(reconnected, drawFor(s, 0)); !errors.Is(err, ErrForbidden) {
		t.Fatal("revoked recovery restored permission", err)
	}
	if err = h.Annotate(owner, drawFor(s, 0)); err != nil {
		t.Fatal("owner lost permission", err)
	}
}

func TestAnnotationHistoryRemainsBoundedUnderRepeatedEraseAndUndo(t *testing.T) {
	h, s, p, other := annotationFixture(t)
	now := time.Now()
	h.cfg.Now = func() time.Time { return now }
	if err := h.Annotate(p, drawFor(s, 0)); err != nil {
		t.Fatal(err)
	}
	drain := func() {
		for _, peer := range []*Peer{p, other} {
			for len(peer.Events) > 0 {
				<-peer.Events
			}
		}
	}
	for i := 0; i < 300; i++ {
		now = now.Add(time.Second)
		drain()
		toolCommand(t, h, s, p, "erase", "stroke-1")
		drain()
		toolCommand(t, h, s, p, "undo", "")
		r := h.rooms[s.ID]
		if len(r.annotations.undo) > 128 || len(r.annotations.redo) > 128 || len(r.annotations.strokes) > maxAnnotationStrokes || r.annotations.points > maxAnnotationPoints {
			t.Fatal("unbounded history")
		}
	}
}
