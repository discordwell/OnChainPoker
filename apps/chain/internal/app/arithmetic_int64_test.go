package app

import (
	"math"
	"testing"
)

func TestAddInt64AndU64Checked(t *testing.T) {
	got, err := addInt64AndU64Checked(42, 10, "deadline")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got != 52 {
		t.Fatalf("unexpected sum: got %d want 52", got)
	}
}

func TestAddInt64AndU64Checked_Overflow(t *testing.T) {
	if _, err := addInt64AndU64Checked(math.MaxInt64, 1, "deadline"); err == nil {
		t.Fatalf("expected overflow error")
	}
	if _, err := addInt64AndU64Checked(0, uint64(math.MaxInt64)+1, "deadline"); err == nil {
		t.Fatalf("expected delta overflow error")
	}
}
