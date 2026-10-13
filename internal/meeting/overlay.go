package meeting

// Overlay is a read-only annotation subscriber, not a participant or media peer.
// All lifecycle changes and queue operations are protected by Hub.mu.
type Overlay struct {
	Events chan Event
	Done   chan struct{}
	peer   *Peer
	epoch  uint32
}

func (h *Hub) overlayPublisher(id, user, session string, epoch uint32) (*room, error) {
	r, err := h.room(id)
	if err != nil {
		return nil, err
	}
	p := r.peers[user]
	if p == nil || p.SessionID != session || r.PublisherID != user {
		return nil, ErrForbidden
	}
	select {
	case <-p.Done:
		return nil, ErrForbidden
	default:
	}
	if !r.Active || r.Epoch != epoch {
		return nil, ErrConflict
	}
	return r, nil
}

func (h *Hub) CheckOverlayPublisher(id, user, session string, epoch uint32) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, err := h.overlayPublisher(id, user, session, epoch)
	return err
}

func closeOverlay(r *room) {
	if r.overlay != nil {
		close(r.overlay.Done)
		r.overlay = nil
	}
}

func (h *Hub) SubscribeOverlay(id, user, session string, epoch uint32) (*Overlay, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, err := h.overlayPublisher(id, user, session, epoch)
	if err != nil {
		return nil, err
	}
	closeOverlay(r)
	o := &Overlay{Events: make(chan Event, 64), Done: make(chan struct{}), peer: r.peers[user], epoch: epoch}
	r.overlay = o
	o.Events <- Event{Type: "annotations", Annotations: annotationSnapshot(r)}
	return o, nil
}

func (h *Hub) UnsubscribeOverlay(o *Overlay) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rooms[o.peer.RoomID]; r != nil && r.overlay == o {
		closeOverlay(r)
	}
}

func (h *Hub) StopOverlay(id, user, session string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.rooms[id]; r != nil && r.overlay != nil && r.overlay.peer.User.ID == user && r.overlay.peer.SessionID == session {
		closeOverlay(r)
	}
}

func (h *Hub) OverlayAlive(o *Overlay) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, err := h.overlayPublisher(o.peer.RoomID, o.peer.User.ID, o.peer.SessionID, o.epoch)
	return err == nil && r.overlay == o
}

func emitOverlay(r *room, e Event) {
	if r.overlay == nil {
		return
	}
	// A slow helper must never stall the publisher or evict meeting participants.
	if e.Annotation != nil && e.Annotation.Kind == "pointer" && len(r.overlay.Events) >= 8 {
		return
	}
	select {
	case r.overlay.Events <- e:
	default:
		closeOverlay(r)
	}
}
