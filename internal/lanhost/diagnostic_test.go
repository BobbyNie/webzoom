package lanhost

import (
	"bytes"
	"context"
	"errors"
	"net"
	"testing"
	"webzoom/internal/lan"
)

func diagnosticPolicy() Policy {
	return Policy{Origin: "https://approved.example", ExtensionID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", InterfaceIP: "192.0.2.4", Port: 34567, MaxMbps: 8}
}
func TestHandshakePrecedesNetworkAccess(t *testing.T) {
	for _, tc := range []struct {
		c    command
		code string
	}{
		{command{Type: "start", Origin: "https://wrong.example", Protocol: 1}, "site_mismatch"},
		{command{Type: "start", Origin: "https://approved.example", Protocol: 2}, "version_mismatch"},
		{command{Type: "shell", Origin: "https://approved.example", Protocol: 1}, "invalid_message"},
	} {
		var in, out bytes.Buffer
		lan.WriteMessage(&in, tc.c)
		err := Run(context.Background(), diagnosticPolicy(), &in, &out)
		if ErrorCode(err) != tc.code {
			t.Fatal(err)
		}
		if out.Len() != 0 {
			t.Fatal("unauthorized output")
		}
	}
}
func TestDiagnosticOnlyBindsAndAlwaysCloses(t *testing.T) {
	p := diagnosticPolicy()
	called := 0
	network := func(string) (*net.IPNet, error) { return &net.IPNet{}, nil }
	var socket *net.UDPConn
	listen := func(int) (*net.UDPConn, error) {
		called++
		var err error
		socket, err = net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		return socket, err
	}
	d := diagnose(p, network, listen)
	if !d.OK || d.BroadcastVerified || d.Code != "local_ready" || called != 1 {
		t.Fatal(d, called)
	}
	if _, err := socket.WriteToUDP([]byte{1}, socket.LocalAddr().(*net.UDPAddr)); !errors.Is(err, net.ErrClosed) {
		t.Fatal("diagnostic leaked socket", err)
	}
	d = diagnose(p, network, func(int) (*net.UDPConn, error) { return nil, errors.New("secret local error") })
	if d.Code != "port_unavailable" || d.OK {
		t.Fatal(d)
	}
	d = diagnose(p, func(string) (*net.IPNet, error) { return nil, errors.New("multiple") }, listen)
	if d.Code != "network_unsupported" || called != 1 {
		t.Fatal(d, called)
	}
	p.Port = 0
	d = diagnose(p, network, listen)
	if d.Code != "policy_invalid" || called != 1 {
		t.Fatal(d, called)
	}
}
