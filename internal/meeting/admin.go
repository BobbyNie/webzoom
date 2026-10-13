package meeting

type EndResult struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

// EndRooms terminates only the requested meetings. The caller must authorize
// the administrator first. One lock serializes concurrent end/transfer/join.
func (h *Hub) EndRooms(ids []string) []EndResult {
	h.mu.Lock()
	defer h.mu.Unlock()
	results := make([]EndResult, 0, len(ids))
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		result := EndResult{ID: id, Status: "not_found"}
		if r, err := h.room(id); err == nil {
			h.end(r, "meeting ended by administrator")
			result.Status = "ended"
		}
		results = append(results, result)
	}
	return results
}
