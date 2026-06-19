package holdem

import (
	"fmt"
	"math/rand"
	"sort"
	"testing"

	"onchainpoker/apps/cosmos/internal/cards"
)

// parseCard turns a two-char label like "As" / "Td" / "2c" into a cards.Card.
// Encoding matches cards.Card: id = suit*13 + (rank-2).
func parseCard(t *testing.T, s string) cards.Card {
	t.Helper()
	if len(s) != 2 {
		t.Fatalf("bad card %q", s)
	}
	var rank int
	switch s[0] {
	case 'A':
		rank = 14
	case 'K':
		rank = 13
	case 'Q':
		rank = 12
	case 'J':
		rank = 11
	case 'T':
		rank = 10
	default:
		if s[0] < '2' || s[0] > '9' {
			t.Fatalf("bad rank in card %q", s)
		}
		rank = int(s[0] - '0')
	}
	var suit int
	switch s[1] {
	case 'c':
		suit = 0
	case 'd':
		suit = 1
	case 'h':
		suit = 2
	case 's':
		suit = 3
	default:
		t.Fatalf("bad suit in card %q", s)
	}
	return cards.Card(suit*13 + (rank - 2))
}

// parseHand parses a whitespace-separated list of card labels.
func parseHand(t *testing.T, s string) []cards.Card {
	t.Helper()
	out := []cards.Card{}
	cur := ""
	flush := func() {
		if cur != "" {
			out = append(out, parseCard(t, cur))
			cur = ""
		}
	}
	for _, ch := range s {
		if ch == ' ' || ch == '\t' || ch == '\n' {
			flush()
			continue
		}
		cur += string(ch)
	}
	flush()
	return out
}

func tbEqual(a, b []uint8) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestEvaluate5KnownAnswers(t *testing.T) {
	cases := []struct {
		name string
		hand string
		cat  HandCategory
		tb   []uint8
	}{
		{"royal flush", "As Ks Qs Js Ts", StraightFlush, []uint8{14}},
		{"steel wheel (5-high straight flush)", "5h 4h 3h 2h Ah", StraightFlush, []uint8{5}},
		{"king-high straight flush", "Kd Qd Jd Td 9d", StraightFlush, []uint8{13}},
		{"quad aces, king kicker", "As Ad Ah Ac Kd", Quads, []uint8{14, 13}},
		{"quad twos, three kicker", "2s 2d 2h 2c 3d", Quads, []uint8{2, 3}},
		{"aces full of kings", "As Ad Ah Ks Kd", FullHouse, []uint8{14, 13}},
		{"twos full of threes", "2s 2d 2h 3s 3d", FullHouse, []uint8{2, 3}},
		{"ace-high flush", "As Qs 9s 5s 2s", Flush, []uint8{14, 12, 9, 5, 2}},
		{"nine-high flush", "9c 7c 5c 3c 2c", Flush, []uint8{9, 7, 5, 3, 2}},
		{"broadway straight", "As Ks Qd Jh Tc", Straight, []uint8{14}},
		{"wheel straight", "Ah 5d 4c 3s 2h", Straight, []uint8{5}},
		{"six-high straight", "6h 5d 4c 3s 2h", Straight, []uint8{6}},
		{"trip kings, Q-J kickers", "Ks Kd Kh Qs Jd", Trips, []uint8{13, 12, 11}},
		{"aces and kings, queen kicker", "As Ad Ks Kd Qh", TwoPair, []uint8{14, 13, 12}},
		{"kings and twos, ace kicker", "Ks Kd 2s 2d Ah", TwoPair, []uint8{13, 2, 14}},
		{"pair of aces, K-Q-J kickers", "As Ad Ks Qd Jh", OnePair, []uint8{14, 13, 12, 11}},
		{"ace-high nothing", "As Kd Qh Js 9c", HighCard, []uint8{14, 13, 12, 11, 9}},
		{"seven-high nothing", "7s 5d 4h 3s 2c", HighCard, []uint8{7, 5, 4, 3, 2}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, err := evaluate5(parseHand(t, tc.hand))
			if err != nil {
				t.Fatalf("evaluate5(%s) error: %v", tc.hand, err)
			}
			if r.Category != tc.cat {
				t.Fatalf("evaluate5(%s) category = %d, want %d", tc.hand, r.Category, tc.cat)
			}
			if !tbEqual(r.Tiebreakers, tc.tb) {
				t.Fatalf("evaluate5(%s) tiebreakers = %v, want %v", tc.hand, r.Tiebreakers, tc.tb)
			}
		})
	}
}

func TestEvaluate5RejectsBadInput(t *testing.T) {
	if _, err := evaluate5(parseHand(t, "As Ks Qs Js")); err == nil {
		t.Fatal("evaluate5 with 4 cards should error")
	}
	// Duplicate card.
	dup := []cards.Card{parseCard(t, "As"), parseCard(t, "As"), parseCard(t, "Kd"), parseCard(t, "Qh"), parseCard(t, "Jc")}
	if _, err := evaluate5(dup); err == nil {
		t.Fatal("evaluate5 with duplicate card should error")
	}
}

// TestCompareHandRankLadder pins the full ranking ladder: each hand must beat
// every weaker hand below it, cross-category AND within-category by tiebreaker.
func TestCompareHandRankLadder(t *testing.T) {
	// Weakest -> strongest.
	ladder := []string{
		"7s 5d 4h 3s 2c", // high card, seven high
		"8s 5d 4h 3s 2c", // high card, eight high (kicker)
		"2h 2d 7c 5s 4h", // pair of twos
		"2h 2d 8c 5s 4h", // pair of twos, better kicker
		"3h 3d 2c 2s 4h", // two pair, threes and twos
		"Ah Ad Ks Kd 2h", // two pair, aces and kings
		"2h 2d 2c 5s 4h", // trip twos
		"6h 5d 4c 3s 2h", // six-high straight
		"Th 9d 8c 7s 6h", // ten-high straight
		"Ah Kd Qc Js Th", // broadway straight
		"2s 5s 8s Js Ks", // king-high flush
		"As 5s 8s Js Ks", // ace-high flush
		"3h 3d 3c 2s 2h", // threes full of twos
		"Ah Ad Ac Ks Kd", // aces full of kings
		"2h 2d 2c 2s 5h", // quad twos
		"Ah Ad Ac As Kd", // quad aces
		"6h 5h 4h 3h 2h", // six-high straight flush
		"As Ks Qs Js Ts", // royal flush
	}

	ranks := make([]HandRank, len(ladder))
	for i, h := range ladder {
		r, err := evaluate5(parseHand(t, h))
		if err != nil {
			t.Fatalf("evaluate5(%s): %v", h, err)
		}
		ranks[i] = r
	}

	for i := 0; i < len(ranks); i++ {
		// Reflexive: a hand ties itself.
		if got := CompareHandRank(ranks[i], ranks[i]); got != 0 {
			t.Fatalf("CompareHandRank(%s, self) = %d, want 0", ladder[i], got)
		}
		for j := i + 1; j < len(ranks); j++ {
			if got := CompareHandRank(ranks[j], ranks[i]); got != 1 {
				t.Fatalf("CompareHandRank(%s > %s) = %d, want 1", ladder[j], ladder[i], got)
			}
			// Antisymmetric.
			if got := CompareHandRank(ranks[i], ranks[j]); got != -1 {
				t.Fatalf("CompareHandRank(%s < %s) = %d, want -1", ladder[i], ladder[j], got)
			}
		}
	}
}

// TestEvaluate7PicksBestFive checks that the 7->5 selection chooses the strongest
// possible five-card hand, including cases where the naive "first five" is wrong.
func TestEvaluate7PicksBestFive(t *testing.T) {
	cases := []struct {
		name string
		hand string
		cat  HandCategory
		tb   []uint8
	}{
		// Best straight is 4-8, not the first-five 2-6.
		{"slides to higher straight", "2c 3d 4h 5s 6c 7d 8h", Straight, []uint8{8}},
		// Five spades present; non-spades must be ignored.
		{"flush among seven", "As Ks 2h 3d Qs Js 9s", Flush, []uint8{14, 13, 12, 11, 9}},
		// Quads + must pick the highest remaining kicker (K over 2).
		{"quads with best kicker", "Ac Ad Ah As Kc Kd 2h", Quads, []uint8{14, 13}},
		// Two trips on board -> aces full of kings.
		{"two trips form full house", "Ac Ad Ah Kc Kd Ks 2h", FullHouse, []uint8{14, 13}},
		// Trips + two pairs available -> full house (aces full of kings, not aces+kicker).
		{"trips plus pair beats trips", "Ac Ad Ah Kc Kd 7s 2h", FullHouse, []uint8{14, 13}},
		// Royal flush hidden among extra cards.
		{"royal among seven", "Ts Js Qs Ks As 2d 7c", StraightFlush, []uint8{14}},
		// Wheel straight flush, with higher off-suit cards that must NOT upgrade it.
		{"steel wheel among seven", "Ah 2h 3h 4h 5h Kd Qc", StraightFlush, []uint8{5}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := Evaluate7(parseHand(t, tc.hand))
			if r.Category != tc.cat {
				t.Fatalf("Evaluate7(%s) category = %d, want %d", tc.hand, r.Category, tc.cat)
			}
			if !tbEqual(r.Tiebreakers, tc.tb) {
				t.Fatalf("Evaluate7(%s) tiebreakers = %v, want %v", tc.hand, r.Tiebreakers, tc.tb)
			}
		})
	}
}

func TestEvaluate7Deterministic(t *testing.T) {
	// Go map iteration order is randomized; ensure the evaluator's sorts make it
	// deterministic across repeated calls on the same input.
	hand := parseHand(t, "As Ad Ks Kd Qs Qd Jh")
	first := Evaluate7(hand)
	for i := 0; i < 50; i++ {
		got := Evaluate7(hand)
		if got.Category != first.Category || !tbEqual(got.Tiebreakers, first.Tiebreakers) {
			t.Fatalf("Evaluate7 nondeterministic: %+v vs %+v", got, first)
		}
	}
}

func boardOf(t *testing.T, s string) []cards.Card {
	t.Helper()
	b := parseHand(t, s)
	if len(b) != 5 {
		t.Fatalf("board %q has %d cards, want 5", s, len(b))
	}
	return b
}

func holeOf(t *testing.T, s string) [2]cards.Card {
	t.Helper()
	h := parseHand(t, s)
	if len(h) != 2 {
		t.Fatalf("hole %q has %d cards, want 2", s, len(h))
	}
	return [2]cards.Card{h[0], h[1]}
}

func TestWinners(t *testing.T) {
	t.Run("single winner by made hand", func(t *testing.T) {
		w, err := Winners(boardOf(t, "As Ks Qd Jh 9c"), map[int][2]cards.Card{
			0: holeOf(t, "Ad 2c"), // pair of aces
			1: holeOf(t, "Kh 2d"), // pair of kings
		})
		if err != nil {
			t.Fatal(err)
		}
		if !reflectIntsEqual(w, []int{0}) {
			t.Fatalf("winners = %v, want [0]", w)
		}
	})

	t.Run("chop when board plays for everyone", func(t *testing.T) {
		w, err := Winners(boardOf(t, "As Ks Qs Js Ts"), map[int][2]cards.Card{
			3: holeOf(t, "2c 3d"),
			0: holeOf(t, "4h 5c"),
		})
		if err != nil {
			t.Fatal(err)
		}
		// Both play the board (royal flush); result sorted ascending.
		if !reflectIntsEqual(w, []int{0, 3}) {
			t.Fatalf("winners = %v, want [0 3]", w)
		}
	})

	t.Run("kicker decides", func(t *testing.T) {
		w, err := Winners(boardOf(t, "Ah Kd Qc 7s 2h"), map[int][2]cards.Card{
			0: holeOf(t, "As Jc"), // pair aces, kickers K Q J
			1: holeOf(t, "Ad Tc"), // pair aces, kickers K Q T
		})
		if err != nil {
			t.Fatal(err)
		}
		if !reflectIntsEqual(w, []int{0}) {
			t.Fatalf("winners = %v, want [0]", w)
		}
	})

	t.Run("six-high straight beats the wheel", func(t *testing.T) {
		w, err := Winners(boardOf(t, "2c 3d 4h 5s Kc"), map[int][2]cards.Card{
			0: holeOf(t, "Ah 9d"), // A-2-3-4-5 wheel
			1: holeOf(t, "6h Td"), // 2-3-4-5-6
		})
		if err != nil {
			t.Fatal(err)
		}
		if !reflectIntsEqual(w, []int{1}) {
			t.Fatalf("winners = %v, want [1]", w)
		}
	})

	t.Run("three-way with one winner", func(t *testing.T) {
		w, err := Winners(boardOf(t, "Ah Kh Qh 2d 3c"), map[int][2]cards.Card{
			2: holeOf(t, "Jh Th"), // royal flush
			0: holeOf(t, "Ad As"), // trip aces
			5: holeOf(t, "Kd Ks"), // trip kings
		})
		if err != nil {
			t.Fatal(err)
		}
		if !reflectIntsEqual(w, []int{2}) {
			t.Fatalf("winners = %v, want [2]", w)
		}
	})

	t.Run("ignores out-of-range seats", func(t *testing.T) {
		w, err := Winners(boardOf(t, "As Ks Qd Jh 9c"), map[int][2]cards.Card{
			-1: holeOf(t, "Ad Ac"), // invalid seat, ignored
			0:  holeOf(t, "2c 2d"), // pair of twos
			9:  holeOf(t, "Kd Kh"), // invalid seat, ignored
		})
		if err != nil {
			t.Fatal(err)
		}
		if !reflectIntsEqual(w, []int{0}) {
			t.Fatalf("winners = %v, want [0]", w)
		}
	})

	t.Run("error on wrong board length", func(t *testing.T) {
		if _, err := Winners(parseHand(t, "As Ks Qd Jh"), map[int][2]cards.Card{0: holeOf(t, "2c 2d")}); err == nil {
			t.Fatal("expected error for 4-card board")
		}
	})

	t.Run("error on duplicate card between hole and board", func(t *testing.T) {
		if _, err := Winners(boardOf(t, "As Ks Qd Jh 9c"), map[int][2]cards.Card{
			0: holeOf(t, "As 2d"), // As also on board
		}); err == nil {
			t.Fatal("expected error for duplicate card")
		}
	})

	t.Run("error when no eligible hands", func(t *testing.T) {
		if _, err := Winners(boardOf(t, "As Ks Qd Jh 9c"), map[int][2]cards.Card{}); err == nil {
			t.Fatal("expected error for empty hole map")
		}
	})
}

func reflectIntsEqual(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestEvaluate5CategoryDistribution is an independent oracle: across all
// C(52,5) = 2,598,960 distinct five-card hands, the count of each category is a
// mathematical constant. Matching every count catches essentially any
// miscategorization (wheel handling, straight/flush confusion, full-house vs
// trips, etc.). Skipped under -short.
func TestEvaluate5CategoryDistribution(t *testing.T) {
	if testing.Short() {
		t.Skip("exhaustive 2.6M-hand enumeration skipped in -short mode")
	}

	want := map[HandCategory]int{
		HighCard:      1302540,
		OnePair:       1098240,
		TwoPair:       123552,
		Trips:         54912,
		Straight:      10200,
		Flush:         5108,
		FullHouse:     3744,
		Quads:         624,
		StraightFlush: 40,
	}

	var counts [9]int
	hand := make([]cards.Card, 5)
	total := 0
	for a := 0; a < 52; a++ {
		hand[0] = cards.Card(a)
		for b := a + 1; b < 52; b++ {
			hand[1] = cards.Card(b)
			for c := b + 1; c < 52; c++ {
				hand[2] = cards.Card(c)
				for d := c + 1; d < 52; d++ {
					hand[3] = cards.Card(d)
					for e := d + 1; e < 52; e++ {
						hand[4] = cards.Card(e)
						r, err := evaluate5(hand)
						if err != nil {
							t.Fatalf("evaluate5 error on %v: %v", hand, err)
						}
						counts[r.Category]++
						total++
					}
				}
			}
		}
	}

	if total != 2598960 {
		t.Fatalf("enumerated %d hands, want 2598960", total)
	}
	for cat, wantN := range want {
		if counts[cat] != wantN {
			t.Errorf("category %d count = %d, want %d", cat, counts[cat], wantN)
		}
	}
}

// TestWinnersConsistencyRandom fuzzes random deals and checks two invariants:
//  1. Evaluate7 equals the maximum over all 21 five-card sub-hands (re-derived
//     independently here), so the 7->5 selection is correct.
//  2. Winners returns exactly the set of seats whose Evaluate7 is maximal, with
//     no panics and correctly sorted output.
func TestWinnersConsistencyRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(0xC0FFEE))
	iters := 5000
	if testing.Short() {
		iters = 500
	}

	for iter := 0; iter < iters; iter++ {
		deck := make([]cards.Card, 52)
		for i := range deck {
			deck[i] = cards.Card(i)
		}
		rng.Shuffle(len(deck), func(i, j int) { deck[i], deck[j] = deck[j], deck[i] })

		var board [5]cards.Card
		copy(board[:], deck[:5])

		nSeats := 2 + rng.Intn(5) // 2..6
		holeBySeat := map[int][2]cards.Card{}
		seatList := rng.Perm(9)[:nSeats]
		off := 5
		for _, seat := range seatList {
			holeBySeat[seat] = [2]cards.Card{deck[off], deck[off+1]}
			off += 2
		}

		// Independent re-derivation of each seat's best 5 of 7.
		bestRankBySeat := map[int]HandRank{}
		for seat, hole := range holeBySeat {
			seven := []cards.Card{board[0], board[1], board[2], board[3], board[4], hole[0], hole[1]}
			best := bestFiveOfSeven(t, seven)

			// Cross-check against the production Evaluate7.
			got := Evaluate7(seven)
			if got.Category != best.Category || !tbEqual(got.Tiebreakers, best.Tiebreakers) {
				t.Fatalf("iter %d seat %d: Evaluate7 = %+v, independent best = %+v (cards %v)",
					iter, seat, got, best, seven)
			}
			bestRankBySeat[seat] = best
		}

		// Expected winners: all seats tied for the max rank, sorted.
		seats := make([]int, 0, len(bestRankBySeat))
		for s := range bestRankBySeat {
			seats = append(seats, s)
		}
		sort.Ints(seats)
		var topRank *HandRank
		var expected []int
		for _, s := range seats {
			r := bestRankBySeat[s]
			if topRank == nil || CompareHandRank(r, *topRank) == 1 {
				rr := r
				topRank = &rr
				expected = []int{s}
			} else if CompareHandRank(r, *topRank) == 0 {
				expected = append(expected, s)
			}
		}

		got, err := Winners(board[:], holeBySeat)
		if err != nil {
			t.Fatalf("iter %d: Winners error: %v", iter, err)
		}
		if !reflectIntsEqual(got, expected) {
			t.Fatalf("iter %d: Winners = %v, want %v (board %v)", iter, got, expected, board)
		}

		// The winners' hand category must be >= every loser's category.
		for _, s := range seats {
			isWinner := false
			for _, w := range got {
				if w == s {
					isWinner = true
					break
				}
			}
			if !isWinner && CompareHandRank(bestRankBySeat[got[0]], bestRankBySeat[s]) != 1 {
				t.Fatalf("iter %d: winner %d not strictly better than loser %d", iter, got[0], s)
			}
		}
	}
}

// bestFiveOfSeven re-derives the best five-card rank from seven cards via an
// independent enumeration (not the package's combos table), used as an oracle.
func bestFiveOfSeven(t *testing.T, seven []cards.Card) HandRank {
	t.Helper()
	if len(seven) != 7 {
		t.Fatalf("bestFiveOfSeven needs 7 cards, got %d", len(seven))
	}
	var best *HandRank
	for i := 0; i < 7; i++ {
		for j := i + 1; j < 7; j++ {
			// Drop cards i and j; evaluate the remaining five.
			five := make([]cards.Card, 0, 5)
			for k := 0; k < 7; k++ {
				if k == i || k == j {
					continue
				}
				five = append(five, seven[k])
			}
			r, err := evaluate5(five)
			if err != nil {
				t.Fatalf("evaluate5(%v): %v", five, err)
			}
			if best == nil || CompareHandRank(r, *best) == 1 {
				rr := r
				best = &rr
			}
		}
	}
	return *best
}

// Sanity guard that the combos table used by Evaluate7 enumerates exactly the
// 21 distinct 5-of-7 selections.
func TestCombosTableComplete(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range combos7Choose5 {
		idx := append([]int(nil), c[:]...)
		sort.Ints(idx)
		key := fmt.Sprintf("%v", idx)
		if seen[key] {
			t.Fatalf("duplicate combo %v", idx)
		}
		seen[key] = true
		for i := 1; i < len(idx); i++ {
			if idx[i] == idx[i-1] {
				t.Fatalf("combo %v has repeated index", c)
			}
		}
	}
	if len(seen) != 21 {
		t.Fatalf("combos table has %d distinct selections, want 21", len(seen))
	}
}
