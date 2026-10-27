package meeting

import (
	"sort"
	"time"
)

type BrowserBytes struct {
	CenterBytes uint64 `json:"centerBytes"`
	PeerBytes   uint64 `json:"peerBytes"`
	SentBytes   uint64 `json:"sentBytes"`
}

// Receiver reports are authenticated self-reports, not independently measured
// delivery acknowledgements or physical company-link bandwidth measurements.
type BrowserReport struct {
	Sharing        *BrowserBytes `json:"sharing,omitempty"`
	PeerPlanFrames uint64        `json:"peerPlanFrames,omitempty"`
	PeerMediaAgeMs uint64        `json:"peerMediaAgeMs,omitempty"`
	Visibility     string        `json:"visibility,omitempty"`
	Generation     uint32        `json:"generation"`
	CenterBytes    uint64        `json:"centerBytes"`
	PeerBytes      uint64        `json:"peerBytes"`
	SentBytes      uint64        `json:"sentBytes"`
	VerifiedFrames uint64        `json:"verifiedFrames"`
	Rejected       uint64        `json:"rejected"`
	PlanFrames     uint64        `json:"planFrames"`
	MediaAgeMs     uint64        `json:"mediaAgeMs"`
}
type BrowserRates struct {
	CenterBps float64 `json:"centerBps"`
	PeerBps   float64 `json:"peerBps"`
	SentBps   float64 `json:"sentBps"`
	SampleMs  int64   `json:"sampleMs"`
}
type BrowserParticipant struct {
	Failure      string         `json:"failure,omitempty"`
	ServerBackup bool           `json:"serverBackup,omitempty"`
	Rates        *BrowserRates  `json:"rates,omitempty"`
	User         User           `json:"user"`
	Role         string         `json:"role"`
	Reason       string         `json:"reason"`
	Parent       string         `json:"parent"`
	Children     int            `json:"children"`
	Report       *BrowserReport `json:"report,omitempty"`
	ReportedAt   int64          `json:"reportedAt"`
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
	case "ice_failed", "channel_closed", "channel_error", "setup_failed", "negotiation_failed", "key_import_failed", "invalid_fragment", "receive_limit", "media_timeout", "connection_timeout", "peer_no_media", "peer_stalled":
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
	case "connection_timeout":
		return "同伴连接未在时限内建立，具体网络原因待核验"
	case "peer_no_media":
		return "同伴数据通道已打开，但未收到可验证画面"
	case "peer_stalled":
		return "同伴曾提供有效画面，随后供画面中断；是否后台暂停待核验"
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
	if v.Visibility != "" && v.Visibility != "unknown" && v.Visibility != "visible" && v.Visibility != "hidden" {
		return ErrConflict
	}
	const max = uint64(1<<53 - 1)
	if v.PeerPlanFrames > max || v.PeerMediaAgeMs > max {
		return ErrConflict
	}
	if v.Sharing != nil && (v.Sharing.CenterBytes > v.CenterBytes || v.Sharing.PeerBytes > v.PeerBytes || v.Sharing.SentBytes > v.SentBytes) {
		return ErrConflict
	}
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
	// Rates are deltas of authenticated self-reports, not physical WAN measurements.
	p.browser.rates = nil
	elapsed := now.Sub(p.browser.reportedAt).Milliseconds()
	if old != nil && old.Generation == v.Generation && elapsed >= 1000 && elapsed <= 8000 {
		factor := 8000 / float64(elapsed)
		p.browser.rates = &BrowserRates{CenterBps: float64(v.CenterBytes-old.CenterBytes) * factor, PeerBps: float64(v.PeerBytes-old.PeerBytes) * factor, SentBps: float64(v.SentBytes-old.SentBytes) * factor, SampleMs: elapsed}
	}
	copy := *v
	p.browser.report = &copy
	p.browser.reportedAt = now
	p.browser.lastReport = now

	if p.browser.recovering {
		if v.PeerPlanFrames >= 3 && v.PeerMediaAgeMs < 2000 {
			if p.browser.recoveryVerifiedAt.IsZero() {
				p.browser.recoveryVerifiedAt = now
				p.browser.recoveryVerifiedFrames = v.PeerPlanFrames
			} else if now.Sub(p.browser.recoveryVerifiedAt) >= 2*time.Second && v.PeerPlanFrames > p.browser.recoveryVerifiedFrames {
				// Two separated fresh reports must show ongoing verified peer progress.
				p.browser.recovering = false
				h.browserReplan(r)
				return nil
			}
		} else {
			p.browser.recoveryVerifiedAt = time.Time{}
			p.browser.recoveryVerifiedFrames = 0
		}
	}

	h.browserTryRecovery(r, p)
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
		row := BrowserParticipant{Failure: p.browser.failure, ServerBackup: p.browser.recovering, User: p.User, Role: p.browser.role, Reason: p.browser.reason, Parent: p.browser.parent, Children: children[id]}
		if p.browser.report != nil && p.browser.report.Generation == r.browser.generation {
			report := *p.browser.report
			row.Report = &report
			if p.browser.rates != nil {
				rates := *p.browser.rates
				row.Rates = &rates
			}
			row.ReportedAt = p.browser.reportedAt.UnixMilli()
		}
		v.Participants = append(v.Participants, row)
	}
	h.emit(owner, Event{Type: "browser-overview", BrowserOverview: v})
}
