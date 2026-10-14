package main

import "testing"

func TestLANConfig(t *testing.T) {
	t.Setenv("LAN_RELAY_ENABLED", "")
	t.Setenv("LAN_MEDIA_BUDGET_MBPS", "")
	c, e := loadLANConfig()
	if e != nil || c.Enabled || c.BudgetMbps != 16 {
		t.Fatal(c, e)
	}
	t.Setenv("LAN_RELAY_ENABLED", "true")
	t.Setenv("LAN_MEDIA_BUDGET_MBPS", "8")
	c, e = loadLANConfig()
	if e != nil || !c.Enabled || c.BudgetMbps != 8 {
		t.Fatal(c, e)
	}
	t.Setenv("LAN_MEDIA_BUDGET_MBPS", "0")
	if _, e = loadLANConfig(); e == nil {
		t.Fatal("invalid budget")
	}
	t.Setenv("LAN_RELAY_ENABLED", "yes")
	if _, e = loadLANConfig(); e == nil {
		t.Fatal("ambiguous flag")
	}
}
