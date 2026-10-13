package bandwidth

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestDefaultThresholdWindowAndRecovery(t *testing.T) {
	now := time.Unix(1000, 0)
	l := New(0, nil)
	if s := l.Status(now); s.LimitMbps != 200 || s.TotalMbps != 0 || s.Blocked || s.WindowSeconds != 5 {
		t.Fatal(s)
	}
	l.Record(now, 125000000) // 200 Mbps over five seconds: equality permits admission.
	if s := l.Status(now); s.Blocked || s.TotalMbps != 200 {
		t.Fatal(s)
	}
	l.Record(now, 1)
	if !l.Status(now).Blocked {
		t.Fatal("excess traffic admitted")
	}
	if l.Status(now.Add(5 * time.Second)).Blocked {
		t.Fatal("old traffic did not expire")
	}
	if s := l.Status(now.Add(6 * time.Second)); s.TotalMbps != 0 {
		t.Fatal(s)
	}
}

func TestRollingTrafficAndImmediateLimitChange(t *testing.T) {
	now := time.Unix(1000, 0)
	l := New(200, nil)
	l.Record(now, 62500000)
	l.Record(now.Add(3*time.Second), 62500000)
	s, err := l.SetLimit(now.Add(3*time.Second), 100)
	if err != nil || !s.Blocked || s.TotalMbps != 200 {
		t.Fatal(s, err)
	}
	s, err = l.SetLimit(now.Add(3*time.Second), 300)
	if err != nil || s.Blocked {
		t.Fatal(s, err)
	}
	if s = l.Status(now.Add(5 * time.Second)); s.TotalMbps != 100 {
		t.Fatal(s)
	}
	for _, n := range []int{-1, 0, 1000001} {
		if _, err := l.SetLimit(now, n); err == nil || l.Status(now).LimitMbps != 300 {
			t.Fatal("invalid limit accepted", n)
		}
	}
	for i := 0; i < 10000; i++ {
		l.Record(now.Add(time.Duration(i)*time.Second), 1)
	}
	if s = l.Status(now.Add(10000 * time.Second)); s.TotalMbps > 0.00001 {
		t.Fatal("unbounded history", s)
	}
}

func TestPersistenceCompletesBeforePolicyChangesAndErrorsKeepOldLimit(t *testing.T) {
	now := time.Unix(1000, 0)
	entered, release := make(chan int, 1), make(chan struct{})
	l := New(200, func(n int) error { entered <- n; <-release; return errors.New("disk full") })
	done := make(chan error, 1)
	go func() { _, err := l.SetLimit(now, 25); done <- err }()
	if n := <-entered; n != 25 {
		t.Fatal(n)
	}
	// Slow storage must not block media accounting or expose an uncommitted limit.
	l.Record(now, 1)
	if l.Status(now).LimitMbps != 200 {
		t.Fatal("policy changed before storage commit")
	}
	close(release)
	if err := <-done; err == nil || l.Status(now).LimitMbps != 200 {
		t.Fatal("failed save changed policy", err)
	}
}

func TestConcurrentAccountingAndSettingsAreRaceFree(t *testing.T) {
	now := time.Unix(1000, 0)
	var saved int
	l := New(200, func(n int) error { saved = n; return nil })
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				l.Record(now, 1)
				l.Status(now)
				if _, err := l.SetLimit(now, i+1); err != nil {
					t.Error(err)
				}
			}
		}(i)
	}
	wg.Wait()
	if s := l.Status(now); s.TotalMbps != 0.0032 || s.LimitMbps != saved {
		t.Fatal(s, saved)
	}
}
