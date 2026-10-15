package lanhost

import (
	"errors"
	"net"
	"webzoom/internal/lan"
)

// Fault codes are bounded, stable IPC values. Raw OS errors never cross the page bridge.
type Fault struct {
	Code  string
	cause error
}

func (e *Fault) Error() string             { return e.Code }
func (e *Fault) Unwrap() error             { return e.cause }
func fault(code string, cause error) error { return &Fault{Code: code, cause: cause} }
func ErrorCode(err error) string {
	var f *Fault
	if errors.As(err, &f) {
		return f.Code
	}
	if errors.Is(err, lan.ErrInvalid) {
		return "invalid_message"
	}
	return "native_stopped"
}

type Diagnostic struct {
	Type              string `json:"type"`
	Protocol          int    `json:"protocol"`
	Code              string `json:"code"`
	OK                bool   `json:"ok"`
	Origin            string `json:"origin"`
	InterfaceIP       string `json:"interfaceIP"`
	Port              int    `json:"port"`
	BroadcastVerified bool   `json:"broadcastVerified"`
}

// Diagnose only binds and closes a socket. It never sends a probe or claims LAN reachability.
func Diagnose(p Policy) Diagnostic { return diagnose(p, ApprovedNetwork, listenUDP) }
func diagnose(p Policy, network func(string) (*net.IPNet, error), listen func(int) (*net.UDPConn, error)) Diagnostic {
	d := Diagnostic{Type: "diagnostic", Protocol: 1, Code: "policy_invalid"}
	if p.Validate("chrome-extension://"+p.ExtensionID+"/") != nil {
		return d
	}
	d.Origin = p.Origin
	d.InterfaceIP = p.InterfaceIP
	d.Port = p.Port
	if _, err := network(p.InterfaceIP); err != nil {
		d.Code = "network_unsupported"
		return d
	}
	conn, err := listen(p.Port)
	if err != nil {
		d.Code = "port_unavailable"
		return d
	}
	conn.Close()
	d.OK = true
	d.Code = "local_ready"
	return d
}
