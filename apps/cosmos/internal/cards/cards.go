package cards

import (
	"crypto/sha256"
	"encoding/binary"
)

// Card is a 0..51 id, where:
// - rank = (id % 13) + 2  (2..14)
// - suit = (id / 13)      (0..3)
//
// This matches the v0 chain representation so we can reuse evaluator logic.
type Card uint8

func (c Card) Rank() uint8 { // 2..14
	return uint8(c%13) + 2
}

func (c Card) Suit() uint8 { // 0..3
	return uint8(c / 13)
}

func (c Card) String() string {
	r := c.Rank()
	var rch byte
	switch r {
	case 14:
		rch = 'A'
	case 13:
		rch = 'K'
	case 12:
		rch = 'Q'
	case 11:
		rch = 'J'
	case 10:
		rch = 'T'
	default:
		rch = byte('0' + (r - 0))
	}
	if r >= 2 && r <= 9 {
		rch = byte('0' + r)
	}
	s := c.Suit()
	var sch byte
	switch s {
	case 0:
		sch = 'c'
	case 1:
		sch = 'd'
	case 2:
		sch = 'h'
	case 3:
		sch = 's'
	default:
		sch = '?'
	}
	return string([]byte{rch, sch})
}

// DeterministicDeck returns a deterministically shuffled 52-card deck.
// This is a dev/testing helper; production dealing should use x/dealer.
func DeterministicDeck(seed []byte) []Card {
	// Fisher-Yates shuffle driven by a sha256-based stream.
	deck := make([]Card, 52)
	for i := 0; i < 52; i++ {
		deck[i] = Card(i)
	}
	// Generate deterministic random bytes by hashing seed||counter.
	var counter uint64
	for i := 51; i > 0; i-- {
		buf := make([]byte, len(seed)+8)
		copy(buf, seed)
		binary.LittleEndian.PutUint64(buf[len(seed):], counter)
		h := sha256.Sum256(buf)
		counter++
		j := int(binary.LittleEndian.Uint64(h[:8]) % uint64(i+1))
		deck[i], deck[j] = deck[j], deck[i]
	}
	return deck
}

