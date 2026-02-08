package state

import (
	"bytes"
	"testing"
)

func TestAppHash_StableAcrossMapOrder(t *testing.T) {
	s1 := NewState()
	s1.Height = 7
	s1.Accounts["bob"] = 2
	s1.Accounts["alice"] = 1
	s1.NextTableID = 42

	s2 := NewState()
	s2.Height = 7
	s2.Accounts["alice"] = 1
	s2.Accounts["bob"] = 2
	s2.NextTableID = 42

	h1 := s1.AppHash()
	h2 := s2.AppHash()
	if !bytes.Equal(h1, h2) {
		t.Fatalf("expected stable app hash; h1=%x h2=%x", h1, h2)
	}

	// Any semantic change should change the hash.
	s2.Accounts["alice"] = 9
	h3 := s2.AppHash()
	if bytes.Equal(h1, h3) {
		t.Fatalf("expected hash to change after state mutation")
	}
}

func TestDeterministicDeck_IsPermutationAndDeterministic(t *testing.T) {
	seed := []byte("seed")
	d1 := DeterministicDeck(seed)
	d2 := DeterministicDeck(seed)
	if len(d1) != 52 || len(d2) != 52 {
		t.Fatalf("expected 52 cards")
	}

	// Determinism.
	for i := 0; i < 52; i++ {
		if d1[i] != d2[i] {
			t.Fatalf("deck mismatch at i=%d: %d vs %d", i, d1[i], d2[i])
		}
	}

	// Permutation (all cards 0..51 exactly once).
	seen := make([]bool, 52)
	for _, c := range d1 {
		if c > 51 {
			t.Fatalf("card out of range: %d", c)
		}
		if seen[c] {
			t.Fatalf("duplicate card: %d", c)
		}
		seen[c] = true
	}
	for i, ok := range seen {
		if !ok {
			t.Fatalf("missing card: %d", i)
		}
	}
}

func TestCard_String(t *testing.T) {
	cases := []struct {
		card Card
		want string
	}{
		{Card(0), "2c"},
		{Card(12), "Ac"},
		{Card(13), "2d"},
		{Card(25), "Ad"},
		{Card(51), "As"},
	}
	for _, tc := range cases {
		if got := tc.card.String(); got != tc.want {
			t.Fatalf("Card(%d).String()=%q want=%q", tc.card, got, tc.want)
		}
	}
}

