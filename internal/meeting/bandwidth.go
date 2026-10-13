package meeting

import "webzoom/internal/bandwidth"

func (h *Hub) BandwidthStatus() bandwidth.Status { return h.bandwidth.Status(h.cfg.Now()) }
func (h *Hub) SetBandwidthLimit(limit int) (bandwidth.Status, error) {
	if _, err := h.bandwidth.SetLimit(h.cfg.Now(), limit); err != nil {
		return bandwidth.Status{}, err
	}
	return h.BandwidthStatus(), nil
}
func (h *Hub) CheckAdmission() error {
	if h.BandwidthStatus().Blocked {
		return ErrBandwidth
	}
	return nil
}
