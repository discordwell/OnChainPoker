package holdem

import (
	"errors"
	"fmt"
	"sort"

	"onchainpoker/apps/cosmos/internal/cards"
)

type HandCategory uint8

const (
	HighCard HandCategory = iota
	OnePair
	TwoPair
	Trips
	Straight
	Flush
	FullHouse
	Quads
	StraightFlush
)

type HandRank struct {
	Category    HandCategory
	Tiebreakers []uint8 // high-to-low lexicographic
}

func CompareHandRank(a, b HandRank) int {
	if a.Category != b.Category {
		if a.Category < b.Category {
			return -1
		}
		return 1
	}
	l := len(a.Tiebreakers)
	if len(b.Tiebreakers) > l {
		l = len(b.Tiebreakers)
	}
	for i := 0; i < l; i++ {
		var av uint8
		var bv uint8
		if i < len(a.Tiebreakers) {
			av = a.Tiebreakers[i]
		}
		if i < len(b.Tiebreakers) {
			bv = b.Tiebreakers[i]
		}
		if av == bv {
			continue
		}
		if av < bv {
			return -1
		}
		return 1
	}
	return 0
}

func assertDistinct(cards []cards.Card, label string) error {
	seen := make([]bool, 52)
	for _, c := range cards {
		if c > 51 {
			return fmt.Errorf("%s contains invalid card id %d", label, c)
		}
		if seen[c] {
			return fmt.Errorf("%s contains duplicate card id %d", label, c)
		}
		seen[c] = true
	}
	return nil
}

func ranksDesc(cards []cards.Card) []uint8 {
	r := make([]uint8, 0, len(cards))
	for _, c := range cards {
		r = append(r, c.Rank())
	}
	sort.Slice(r, func(i, j int) bool { return r[i] > r[j] })
	return r
}

func straightHighFromRanksDesc(uniqueRanksDesc []uint8) (uint8, bool) {
	if len(uniqueRanksDesc) != 5 {
		return 0, false
	}
	// Detect wheel (A-5) specially.
	hasAce := uniqueRanksDesc[0] == 14
	wheel := hasAce && uniqueRanksDesc[1] == 5 && uniqueRanksDesc[2] == 4 && uniqueRanksDesc[3] == 3 && uniqueRanksDesc[4] == 2
	if wheel {
		return 5, true
	}
	for i := 1; i < len(uniqueRanksDesc); i++ {
		if uniqueRanksDesc[i-1]-1 != uniqueRanksDesc[i] {
			return 0, false
		}
	}
	return uniqueRanksDesc[0], true
}

func evaluate5(cards5 []cards.Card) (HandRank, error) {
	if len(cards5) != 5 {
		return HandRank{}, fmt.Errorf("evaluate5 expected 5 cards, got %d", len(cards5))
	}
	if err := assertDistinct(cards5, "cards5"); err != nil {
		return HandRank{}, err
	}

	suits := make([]uint8, 0, 5)
	for _, c := range cards5 {
		suits = append(suits, c.Suit())
	}
	isFlush := true
	for i := 1; i < len(suits); i++ {
		if suits[i] != suits[0] {
			isFlush = false
			break
		}
	}

	ranks := ranksDesc(cards5)
	counts := map[uint8]uint8{}
	for _, r := range ranks {
		counts[r] = counts[r] + 1
	}
	uniqueRanksDesc := make([]uint8, 0, len(counts))
	for r := range counts {
		uniqueRanksDesc = append(uniqueRanksDesc, r)
	}
	sort.Slice(uniqueRanksDesc, func(i, j int) bool { return uniqueRanksDesc[i] > uniqueRanksDesc[j] })

	straightHigh, isStraight := straightHighFromRanksDesc(uniqueRanksDesc)

	type group struct {
		rank  uint8
		count uint8
	}
	groups := make([]group, 0, len(counts))
	for r, c := range counts {
		groups = append(groups, group{rank: r, count: c})
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].count != groups[j].count {
			return groups[i].count > groups[j].count
		}
		return groups[i].rank > groups[j].rank
	})

	if isStraight && isFlush {
		return HandRank{Category: StraightFlush, Tiebreakers: []uint8{straightHigh}}, nil
	}
	if groups[0].count == 4 {
		quadRank := groups[0].rank
		var kicker uint8
		for _, g := range groups {
			if g.count == 1 {
				kicker = g.rank
				break
			}
		}
		return HandRank{Category: Quads, Tiebreakers: []uint8{quadRank, kicker}}, nil
	}
	if groups[0].count == 3 && groups[1].count == 2 {
		return HandRank{Category: FullHouse, Tiebreakers: []uint8{groups[0].rank, groups[1].rank}}, nil
	}
	if isFlush {
		return HandRank{Category: Flush, Tiebreakers: ranks}, nil
	}
	if isStraight {
		return HandRank{Category: Straight, Tiebreakers: []uint8{straightHigh}}, nil
	}
	if groups[0].count == 3 {
		tripsRank := groups[0].rank
		kickers := []uint8{}
		for _, g := range groups {
			if g.count == 1 {
				kickers = append(kickers, g.rank)
			}
		}
		sort.Slice(kickers, func(i, j int) bool { return kickers[i] > kickers[j] })
		return HandRank{Category: Trips, Tiebreakers: append([]uint8{tripsRank}, kickers...)}, nil
	}
	if groups[0].count == 2 && groups[1].count == 2 {
		pairRanks := []uint8{groups[0].rank, groups[1].rank}
		sort.Slice(pairRanks, func(i, j int) bool { return pairRanks[i] > pairRanks[j] })
		var kicker uint8
		for _, g := range groups {
			if g.count == 1 {
				kicker = g.rank
				break
			}
		}
		return HandRank{Category: TwoPair, Tiebreakers: []uint8{pairRanks[0], pairRanks[1], kicker}}, nil
	}
	if groups[0].count == 2 {
		pairRank := groups[0].rank
		kickers := []uint8{}
		for _, g := range groups {
			if g.count == 1 {
				kickers = append(kickers, g.rank)
			}
		}
		sort.Slice(kickers, func(i, j int) bool { return kickers[i] > kickers[j] })
		return HandRank{Category: OnePair, Tiebreakers: append([]uint8{pairRank}, kickers...)}, nil
	}

	return HandRank{Category: HighCard, Tiebreakers: ranks}, nil
}

var combos7Choose5 = [21][5]int{
	{0, 1, 2, 3, 4},
	{0, 1, 2, 3, 5},
	{0, 1, 2, 3, 6},
	{0, 1, 2, 4, 5},
	{0, 1, 2, 4, 6},
	{0, 1, 2, 5, 6},
	{0, 1, 3, 4, 5},
	{0, 1, 3, 4, 6},
	{0, 1, 3, 5, 6},
	{0, 1, 4, 5, 6},
	{0, 2, 3, 4, 5},
	{0, 2, 3, 4, 6},
	{0, 2, 3, 5, 6},
	{0, 2, 4, 5, 6},
	{0, 3, 4, 5, 6},
	{1, 2, 3, 4, 5},
	{1, 2, 3, 4, 6},
	{1, 2, 3, 5, 6},
	{1, 2, 4, 5, 6},
	{1, 3, 4, 5, 6},
	{2, 3, 4, 5, 6},
}

func Evaluate7(cards7 []cards.Card) HandRank {
	if len(cards7) != 7 {
		panic(fmt.Sprintf("Evaluate7 expected 7 cards, got %d", len(cards7)))
	}
	// Note: Evaluate7's public signature is kept as-is for callers that assume
	// card sources are already validated by the dealer module. Use Winners for a
	// safe API that returns errors.
	if err := assertDistinct(cards7, "cards7"); err != nil {
		panic(err.Error())
	}

	var best *HandRank
	for _, idx := range combos7Choose5 {
		r, err := evaluate5([]cards.Card{cards7[idx[0]], cards7[idx[1]], cards7[idx[2]], cards7[idx[3]], cards7[idx[4]]})
		if err != nil {
			panic(err.Error())
		}
		if best == nil || CompareHandRank(r, *best) == 1 {
			tmp := r
			best = &tmp
		}
	}
	return *best
}

func Winners(board5 []cards.Card, holeBySeat map[int][2]cards.Card) ([]int, error) {
	if len(board5) != 5 {
		return nil, fmt.Errorf("Winners expected 5 board cards, got %d", len(board5))
	}
	if err := assertDistinct(board5, "board5"); err != nil {
		return nil, err
	}

	type entry struct {
		seat int
		hole [2]cards.Card
	}
	entries := make([]entry, 0, len(holeBySeat))
	for seat, hole := range holeBySeat {
		if seat < 0 || seat > 8 {
			continue
		}
		entries = append(entries, entry{seat: seat, hole: hole})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].seat < entries[j].seat })

	var best *HandRank
	bestSeats := []int{}
	for _, e := range entries {
		cards7 := []cards.Card{board5[0], board5[1], board5[2], board5[3], board5[4], e.hole[0], e.hole[1]}
		if err := assertDistinct(cards7, fmt.Sprintf("seat %d cards", e.seat)); err != nil {
			return nil, err
		}
		r := Evaluate7(cards7)
		if best == nil {
			tmp := r
			best = &tmp
			bestSeats = []int{e.seat}
			continue
		}
		cmp := CompareHandRank(r, *best)
		if cmp == 1 {
			tmp := r
			best = &tmp
			bestSeats = []int{e.seat}
		} else if cmp == 0 {
			bestSeats = append(bestSeats, e.seat)
		}
	}

	if best == nil {
		return nil, errors.New("no eligible hands to evaluate")
	}
	sort.Ints(bestSeats)
	return bestSeats, nil
}
