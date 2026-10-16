package meeting

import "sort"

// Receiver reports are authenticated self-reports, not independently measured
// delivery acknowledgements or physical company-link bandwidth measurements.
type BrowserReport struct {
	Generation     uint32 `json:"generation"`
	CenterBytes    uint64 `json:"centerBytes"`
	PeerBytes      uint64 `json:"peerBytes"`
	SentBytes      uint64 `json:"sentBytes"`
	VerifiedFrames uint64 `json:"verifiedFrames"`
	Rejected       uint64 `json:"rejected"`
	PlanFrames     uint64 `json:"planFrames"`
	MediaAgeMs     uint64 `json:"mediaAgeMs"`
}
type BrowserParticipant struct {
	User       User           `json:"user"`
	Role       string         `json:"role"`
	Reason     string         `json:"reason"`
	Parent     string         `json:"parent"`
	Children   int            `json:"children"`
	Report     *BrowserReport `json:"report,omitempty"`
	ReportedAt int64          `json:"reportedAt"`
}
type BrowserOverview struct {
	Generation   uint32               `json:"generation"`
	Active       bool                 `json:"active"`
	GeneratedAt  int64                `json:"generatedAt"`
	MaxViewers   int                  `json:"maxViewers"`
	MaxFanout    int                  `json:"maxFanout"`
	Participants []BrowserParticipant `json:"participants"`
}

func browserFailureCode(code string) string {
	switch code {
	case "ice_failed", "channel_closed", "channel_error", "setup_failed", "negotiation_failed", "key_import_failed", "invalid_fragment", "receive_limit", "media_timeout":
		return code
	default:
		return "connection_failed"
	}
}
func browserFailureText(code string) string {
	switch code {
	case "ice_failed":
		return "浏览器报告同伴连接建立或维持失败（原因待核验）"
	case "channel_closed":
		return "同伴数据通道已关闭"
	case "channel_error":
		return "同伴数据通道报错"
	case "setup_failed":
		return "浏览器未能创建同伴连接（可能是策略或能力限制）"
	case "negotiation_failed":
		return "同伴连接协商未完成"
	case "key_import_failed":
		return "画面验证密钥加载失败"
	case "invalid_fragment":
		return "收到的画面分片不符合协议"
	case "receive_limit":
		return "同伴接收流量超过安全上限"
	case "media_timeout":
		return "同伴未持续提供可验证画面，具体原因待核验"
	default:
		return "同伴连接不可用，具体原因待核验"
	}
}
func (h *Hub) browserReport(r *room, p *Peer, c BrowserCommand) error {
	if !r.BrowserRelayEnabled || !r.Active || c.Generation != r.browser.generation {
		return nil
	}
	v := c.Report
	if !p.browser.known || v == nil || v.Generation != c.Generation {
		return ErrConflict
	}
	const max = uint64(1<<53 - 1)
	if v.CenterBytes > max || v.PeerBytes > max || v.SentBytes > max || v.VerifiedFrames > max || v.Rejected > max || v.PlanFrames > v.VerifiedFrames || v.MediaAgeMs > max {
		return ErrConflict
	}
	old := p.browser.report
	if old != nil && (v.CenterBytes < old.CenterBytes || v.PeerBytes < old.PeerBytes || v.SentBytes < old.SentBytes || v.VerifiedFrames < old.VerifiedFrames || v.Rejected < old.Rejected) {
		return ErrConflict
	}
	now := h.cfg.Now()
	if !p.browser.lastReport.IsZero() && now.Sub(p.browser.lastReport).Milliseconds() < 1000 {
		return nil
	}
	copy := *v
	p.browser.report = &copy
	p.browser.reportedAt = now
	p.browser.lastReport = now
	h.browserOverview(r, false)
	return nil
}
func (h *Hub) browserOverview(r *room, force bool) {
	owner := r.peers[r.OwnerID]
	if owner == nil {
		return
	}
	now := h.cfg.Now()
	if !force && !r.browser.overviewAt.IsZero() && now.Sub(r.browser.overviewAt).Milliseconds() < 1000 {
		return
	}
	r.browser.overviewAt = now
	v := &BrowserOverview{Generation: r.browser.generation, Active: r.BrowserRelayEnabled && r.Active, GeneratedAt: now.UnixMilli(), MaxViewers: h.cfg.BrowserRelayMaxViewers, MaxFanout: browserMaxFanout, Participants: []BrowserParticipant{}}
	children := map[string]int{}
	for _, p := range r.peers {
		if p.browser.parent != "" {
			children[p.browser.parent]++
		}
	}
	ids := make([]string, 0, len(r.peers))
	for id := range r.peers {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := r.peers[id]
		row := BrowserParticipant{User: p.User, Role: p.browser.role, Reason: p.browser.reason, Parent: p.browser.parent, Children: children[id]}
		if p.browser.report != nil && p.browser.report.Generation == r.browser.generation {
			report := *p.browser.report
			row.Report = &report
			row.ReportedAt = p.browser.reportedAt.UnixMilli()
		}
		v.Participants = append(v.Participants, row)
	}
	h.emit(owner, Event{Type: "browser-overview", BrowserOverview: v})
}
