package meeting

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func mustRequestAction(t *testing.T, h *Hub, id, actor, action, target string) Snapshot {
	t.Helper()
	s, err := h.Action(id, actor, action, target)
	if err != nil {
		t.Fatalf("%s by %s: %v", action, actor, err)
	}
	return s
}

func TestAnnotationRequestsRequireHostApproval(t *testing.T) {
	h, s, _, guest := annotationFixture(t)
	queued := mustRequestAction(t, h, s.ID, "guest", "annotation-request", "")
	if !reflect.DeepEqual(queued.AnnotationRequests, []string{"guest"}) || len(queued.Annotators) != 0 {
		t.Fatal(queued)
	}
	if err := h.Annotate(guest, drawFor(s, 0)); !errors.Is(err, ErrForbidden) {
		t.Fatal("request granted drawing", err)
	}
	// Duplicates are idempotent and do not fill the control queues.
	for range 100 {
		mustRequestAction(t, h, s.ID, "guest", "annotation-request", "")
	}
	select {
	case <-guest.Done:
		t.Fatal("duplicate requests flooded control queue")
	default:
	}
	for _, action := range []string{"annotation-grant", "annotation-revoke", "annotation-approve", "annotation-deny", "annotation-approve-all"} {
		if _, err := h.Action(s.ID, "guest", action, "guest"); !errors.Is(err, ErrForbidden) {
			t.Fatalf("participant could %s: %v", action, err)
		}
	}
	if _, err := h.Action(s.ID, "outsider", "annotation-request", ""); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
	if _, err := h.Action(s.ID, "guest", "annotation-request", "owner"); !errors.Is(err, ErrForbidden) {
		t.Fatal("request impersonation", err)
	}
	if _, err := h.Action(s.ID, "owner", "annotation-request", ""); !errors.Is(err, ErrForbidden) {
		t.Fatal("owner requested own permission", err)
	}
	approved := mustRequestAction(t, h, s.ID, "owner", "annotation-approve", "guest")
	if len(approved.AnnotationRequests) != 0 || !reflect.DeepEqual(approved.Annotators, []string{"guest"}) || approved.PublisherID != s.PublisherID || approved.Epoch != s.Epoch {
		t.Fatal(approved)
	}
	if err := h.Annotate(guest, drawFor(s, 0)); err != nil {
		t.Fatal(err)
	}
	// Already-authorized users cannot create a fresh pending request.
	next := mustRequestAction(t, h, s.ID, "guest", "annotation-request", "")
	if len(next.AnnotationRequests) != 0 {
		t.Fatal(next)
	}
	mustRequestAction(t, h, s.ID, "owner", "annotation-revoke", "guest")
	if err := h.Annotate(guest, drawFor(s, 0)); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
}

func TestAnnotationRequestsCancelDenyAndStaleApproval(t *testing.T) {
	h, s, _, _ := annotationFixture(t)
	mustRequestAction(t, h, s.ID, "guest", "annotation-request", "")
	if _, err := h.Action(s.ID, "guest", "annotation-cancel", "owner"); !errors.Is(err, ErrForbidden) {
		t.Fatal(err)
	}
	cancelled := mustRequestAction(t, h, s.ID, "guest", "annotation-cancel", "")
	if len(cancelled.AnnotationRequests) != 0 {
		t.Fatal(cancelled)
	}
	for _, action := range []string{"annotation-approve", "annotation-deny"} {
		stale := mustRequestAction(t, h, s.ID, "owner", action, "guest")
		if len(stale.Annotators) != 0 {
			t.Fatal("stale request granted", stale)
		}
	}
	mustRequestAction(t, h, s.ID, "guest", "annotation-request", "")
	denied := mustRequestAction(t, h, s.ID, "owner", "annotation-deny", "guest")
	if len(denied.AnnotationRequests) != 0 || len(denied.Annotators) != 0 {
		t.Fatal(denied)
	}
	mustRequestAction(t, h, s.ID, "guest", "annotation-request", "")
	granted := mustRequestAction(t, h, s.ID, "owner", "annotation-grant", "guest")
	if len(granted.AnnotationRequests) != 0 || len(granted.Annotators) != 1 {
		t.Fatal("manual grant left stale request", granted)
	}
	// A delayed deny is harmless after authorization, not a revoke.
	denied = mustRequestAction(t, h, s.ID, "owner", "annotation-deny", "guest")
	if len(denied.Annotators) != 1 {
		t.Fatal(denied)
	}
}

func TestAnnotationApproveAllOnlyCurrentApplicants(t *testing.T) {
	h, s, _, _ := annotationFixture(t)
	for _, id := range []string{"guest2", "bystander", "cancelled"} {
		if _, err := h.Join(s.ID, User{ID: id, Name: id}, id); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"guest2", "guest", "cancelled"} {
		mustRequestAction(t, h, s.ID, id, "annotation-request", "")
	}
	mustRequestAction(t, h, s.ID, "cancelled", "annotation-cancel", "")
	if _, err := h.Action(s.ID, "owner", "annotation-approve-all", "bystander"); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
	approved := mustRequestAction(t, h, s.ID, "owner", "annotation-approve-all", "")
	if !reflect.DeepEqual(approved.Annotators, []string{"guest", "guest2"}) || len(approved.AnnotationRequests) != 0 {
		t.Fatal(approved)
	}
	again := mustRequestAction(t, h, s.ID, "owner", "annotation-approve-all", "")
	if !reflect.DeepEqual(approved.Annotators, again.Annotators) {
		t.Fatal(again)
	}
	// Future requests are not covered by an earlier bulk approval.
	queued := mustRequestAction(t, h, s.ID, "bystander", "annotation-request", "")
	if !reflect.DeepEqual(queued.AnnotationRequests, []string{"bystander"}) || len(queued.Annotators) != 2 {
		t.Fatal(queued)
	}
}

func TestAnnotationRequestsDisconnectAndSnapshotIsolation(t *testing.T) {
	h, s, owner, guest := annotationFixture(t)
	queued := mustRequestAction(t, h, s.ID, "guest", "annotation-request", "")
	queued.AnnotationRequests[0] = "forged"
	got, _ := h.Get(s.ID)
	if !reflect.DeepEqual(got.AnnotationRequests, []string{"guest"}) {
		t.Fatal("mutable snapshot", got)
	}
	// Requests, like grants, belong to the meeting connection, not one screen epoch.
	mustRequestAction(t, h, s.ID, "owner", "stop", "")
	got = mustRequestAction(t, h, s.ID, "owner", "start", "")
	if len(got.AnnotationRequests) != 1 {
		t.Fatal(got)
	}
	// The host can reconnect and still see live applicants.
	h.Leave(owner)
	rejoined, err := h.Join(s.ID, owner.User, "new-owner-session")
	if err != nil {
		t.Fatal(err)
	}
	event := <-rejoined.Events
	if event.Room == nil || !reflect.DeepEqual(event.Room.AnnotationRequests, []string{"guest"}) {
		t.Fatal(event)
	}
	h.Leave(guest)
	got = mustRequestAction(t, h, s.ID, "owner", "annotation-approve-all", "")
	if len(got.Annotators) != 0 || len(got.AnnotationRequests) != 0 {
		t.Fatal("departed applicant granted", got)
	}
	if _, err = h.Join(s.ID, guest.User, "new-guest-session"); err != nil {
		t.Fatal(err)
	}
	got, _ = h.Get(s.ID)
	if len(got.AnnotationRequests) != 0 || len(got.Annotators) != 0 {
		t.Fatal("reconnect restored old request", got)
	}
	mustRequestAction(t, h, s.ID, "owner", "end", "")
	if _, err = h.Action(s.ID, "guest", "annotation-request", ""); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}

func TestAnnotationRequestRateAndRecovery(t *testing.T) {
	h, s, owner, guest := annotationFixture(t)
	now := time.Now()
	h.cfg.Now = func() time.Time { return now }
	for range 5 {
		mustRequestAction(t, h, s.ID, "guest", "annotation-request", "")
		mustRequestAction(t, h, s.ID, "guest", "annotation-cancel", "")
	}
	if _, err := h.Action(s.ID, "guest", "annotation-request", ""); !errors.Is(err, ErrAnnotationRequestRate) {
		t.Fatal("request churn not limited", err)
	}
	got, _ := h.Get(s.ID)
	if len(got.AnnotationRequests) != 0 || len(got.Annotators) != 0 {
		t.Fatal(got)
	}
	select {
	case <-owner.Done:
		t.Fatal("request churn disconnected host")
	default:
	}
	now = now.Add(10 * time.Second)
	mustRequestAction(t, h, s.ID, "guest", "annotation-request", "")
	// Revoking the authenticated session removes the request as well.
	h.RevokeSession(guest.SessionID)
	got, _ = h.Get(s.ID)
	if len(got.AnnotationRequests) != 0 {
		t.Fatal("expired session left request", got)
	}
}
