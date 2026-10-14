package main

import (
	"fmt"
	"os"
	"strconv"
	"webzoom/internal/meeting"
)

func loadLANConfig() (meeting.LANConfig, error) {
	c := meeting.LANConfig{BudgetMbps: 16, StreamMbps: 8}
	enabled := os.Getenv("LAN_RELAY_ENABLED")
	if enabled != "" && enabled != "false" && enabled != "true" {
		return c, fmt.Errorf("LAN_RELAY_ENABLED must be true or false")
	}
	c.Enabled = enabled == "true"
	if s := os.Getenv("LAN_MEDIA_BUDGET_MBPS"); s != "" {
		n, e := strconv.Atoi(s)
		if e != nil || n < 8 || n > 1000 {
			return c, fmt.Errorf("LAN_MEDIA_BUDGET_MBPS must be 8..1000")
		}
		c.BudgetMbps = n
	}
	return c, nil
}
