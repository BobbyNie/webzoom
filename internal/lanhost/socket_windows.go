package lanhost

import (
	"context"
	"net"
	"syscall"
)

func listenUDP(port int) (*net.UDPConn, error) {
	lc := net.ListenConfig{Control: func(network, address string, c syscall.RawConn) error {
		var err error
		e := c.Control(func(fd uintptr) {
			err = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, syscall.SO_BROADCAST, 1)
			if err == nil {
				err = syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, -5, 1)
			}
		})
		if e != nil {
			return e
		}
		return err
	}}
	pc, e := lc.ListenPacket(context.Background(), "udp4", net.JoinHostPort("0.0.0.0", fmtPort(port)))
	if e != nil {
		return nil, e
	}
	return pc.(*net.UDPConn), nil
}
