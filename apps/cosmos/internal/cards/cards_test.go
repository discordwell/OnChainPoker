package cards

import (
	"bytes"
	"testing"
)

func TestRankAndSuit(t *testing.T) {
	for id := 0; id < 52; id++ {
		c := Card(id)
		wantRank := uint8(id%13) + 2
		wantSuit := uint8(id / 13)
		if c.Rank() != wantRank {
			t.Fatalf("Card(%d).Rank() = %d, want %d", id, c.Rank(), wantRank)
		}
		if c.Suit() != wantSuit {
			t.Fatalf("Card(%d).Suit() = %d, want %d", id, c.Suit(), wantSuit)
		}
		if c.Rank() < 2 || c.Rank() > 14 {
			t.Fatalf("Card(%d).Rank() = %d out of [2,14]", id, c.Rank())
		}
		if c.Suit() > 3 {
			t.Fatalf("Card(%d).Suit() = %d out of [0,3]", id, c.Suit())
		}
	}
}

func TestStringKnownValues(t *testing.T) {
	cases := map[int]string{
		0:  "2c", // rank 2, clubs
		8:  "Tc", // rank 10
		12: "Ac", // rank 14
		13: "2d", // suit rolls over to diamonds
		25: "Ad",
		26: "2h",
		38: "Ah", // last card of the hearts suit
		39: "2s", // suit rolls over to spades
		51: "As", // top card
	}
	for id, want := range cases {
		if got := Card(id).String(); got != want {
			t.Fatalf("Card(%d).String() = %q, want %q", id, got, want)
		}
	}
}

func TestStringFormatAndUniqueness(t *testing.T) {
	const ranks = "23456789TJQKA"
	const suits = "cdhs"
	seen := map[string]bool{}
	for id := 0; id < 52; id++ {
		s := Card(id).String()
		if len(s) != 2 {
			t.Fatalf("Card(%d).String() = %q, want 2 chars", id, s)
		}
		ri := int(Card(id).Rank()) - 2
		si := int(Card(id).Suit())
		if s[0] != ranks[ri] {
			t.Fatalf("Card(%d).String() rank char = %q, want %q", id, s[0], ranks[ri])
		}
		if s[1] != suits[si] {
			t.Fatalf("Card(%d).String() suit char = %q, want %q", id, s[1], suits[si])
		}
		if seen[s] {
			t.Fatalf("Card(%d).String() = %q is a duplicate label", id, s)
		}
		seen[s] = true
	}
	if len(seen) != 52 {
		t.Fatalf("got %d distinct labels, want 52", len(seen))
	}
}

func TestDeterministicDeckIsPermutation(t *testing.T) {
	deck := DeterministicDeck([]byte("seed-1"))
	if len(deck) != 52 {
		t.Fatalf("deck len = %d, want 52", len(deck))
	}
	seen := make([]bool, 52)
	for _, c := range deck {
		if c > 51 {
			t.Fatalf("deck contains invalid card %d", c)
		}
		if seen[c] {
			t.Fatalf("deck contains duplicate card %d", c)
		}
		seen[c] = true
	}
	for i, ok := range seen {
		if !ok {
			t.Fatalf("deck missing card %d", i)
		}
	}
}

func TestDeterministicDeckDeterminism(t *testing.T) {
	a := DeterministicDeck([]byte("same-seed"))
	b := DeterministicDeck([]byte("same-seed"))
	if !cardsEqual(a, b) {
		t.Fatal("same seed produced different decks")
	}
	c := DeterministicDeck([]byte("other-seed"))
	if cardsEqual(a, c) {
		t.Fatal("different seeds produced identical decks (shuffle not seed-dependent)")
	}
}

func cardsEqual(a, b []Card) bool {
	if len(a) != len(b) {
		return false
	}
	ab := make([]byte, len(a))
	bb := make([]byte, len(b))
	for i := range a {
		ab[i] = byte(a[i])
		bb[i] = byte(b[i])
	}
	return bytes.Equal(ab, bb)
}
