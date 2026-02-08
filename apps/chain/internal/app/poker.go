package app

import (
	"fmt"
	"sort"
	"strings"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/state"
)

func occupiedSeatsWithStack(t *state.Table) []int {
	out := make([]int, 0, 9)
	for i := 0; i < 9; i++ {
		if t.Seats[i] == nil {
			continue
		}
		if t.Seats[i].Stack == 0 {
			continue
		}
		out = append(out, i)
	}
	sort.Ints(out)
	return out
}

func nextOccupiedSeat(t *state.Table, from int) int {
	for step := 1; step <= 9; step++ {
		i := (from + step) % 9
		if t.Seats[i] != nil && t.Seats[i].Stack > 0 {
			return i
		}
	}
	return from
}

func activeSeatCount(t *state.Table) int {
	n := 0
	for i := 0; i < 9; i++ {
		s := t.Seats[i]
		if s == nil || !s.InHand || s.Folded {
			continue
		}
		n++
	}
	return n
}

func remainingActiveSeats(t *state.Table) []int {
	out := []int{}
	for i := 0; i < 9; i++ {
		s := t.Seats[i]
		if s == nil || !s.InHand || s.Folded {
			continue
		}
		out = append(out, i)
	}
	return out
}

func blindSeats(t *state.Table) (sbSeat int, bbSeat int) {
	active := occupiedSeatsWithStack(t)
	if len(active) < 2 {
		return -1, -1
	}
	if len(active) == 2 {
		// Heads-up: button posts SB.
		sbSeat = t.ButtonSeat
		bbSeat = nextOccupiedSeat(t, sbSeat)
		return sbSeat, bbSeat
	}
	sbSeat = nextOccupiedSeat(t, t.ButtonSeat)
	bbSeat = nextOccupiedSeat(t, sbSeat)
	return sbSeat, bbSeat
}

func postBlind(t *state.Table, seatIdx int, amount uint64) error {
	h := t.Hand
	s := t.Seats[seatIdx]
	if h == nil || s == nil {
		return fmt.Errorf("invalid blind seat")
	}
	if s.Stack == 0 {
		return fmt.Errorf("no chips")
	}
	put := amount
	if put > s.Stack {
		put = s.Stack
	}
	s.Stack -= put
	s.BetThisRound += put
	h.Pot += put
	if s.Stack == 0 {
		s.AllIn = true
	}
	return nil
}

func dealHoleCards(t *state.Table) {
	h := t.Hand
	if h == nil {
		return
	}

	active := occupiedSeatsWithStack(t)
	if len(active) < 2 {
		return
	}
	start := nextOccupiedSeat(t, t.ButtonSeat)
	if len(active) == 2 {
		// Heads-up: button gets first card.
		start = t.ButtonSeat
	}

	order := []int{}
	cur := start
	for {
		if t.Seats[cur] != nil && t.Seats[cur].Stack > 0 {
			order = append(order, cur)
		}
		cur = nextOccupiedSeat(t, cur)
		if cur == start {
			break
		}
	}

	for c := 0; c < 2; c++ {
		for _, seatIdx := range order {
			if int(h.DeckCursor) >= len(h.Deck) {
				return
			}
			t.Seats[seatIdx].Hole[c] = h.Deck[h.DeckCursor]
			h.DeckCursor++
		}
	}
}

func holeCardEvents(tableID, handID uint64, t *state.Table) []abci.Event {
	events := []abci.Event{}
	for i := 0; i < 9; i++ {
		s := t.Seats[i]
		if s == nil || !s.InHand {
			continue
		}
		events = append(events, abci.Event{
			Type: "HoleCardAssigned",
			Attributes: []abci.EventAttribute{
				{Key: "tableId", Value: fmt.Sprintf("%d", tableID), Index: true},
				{Key: "handId", Value: fmt.Sprintf("%d", handID), Index: true},
				{Key: "seat", Value: fmt.Sprintf("%d", i), Index: true},
				{Key: "player", Value: s.Player, Index: true},
				{Key: "card0", Value: s.Hole[0].String(), Index: false},
				{Key: "card1", Value: s.Hole[1].String(), Index: false},
			},
		})
	}
	return events
}

func firstToActPreflop(t *state.Table, sbSeat, bbSeat int) int {
	active := occupiedSeatsWithStack(t)
	if len(active) == 2 {
		return sbSeat
	}
	return nextActiveSeat(t, bbSeat)
}

func firstToActPostflop(t *state.Table) int {
	return nextActiveSeat(t, t.ButtonSeat)
}

func nextActiveSeat(t *state.Table, from int) int {
	for step := 1; step <= 9; step++ {
		i := (from + step) % 9
		s := t.Seats[i]
		if s == nil || !s.InHand || s.Folded || s.AllIn {
			continue
		}
		return i
	}
	return -1
}

func resetBettingRound(t *state.Table) {
	h := t.Hand
	if h == nil {
		return
	}
	h.CurrentBet = 0
	for i := 0; i < 9; i++ {
		s := t.Seats[i]
		if s == nil || !s.InHand || s.Folded {
			continue
		}
		s.BetThisRound = 0
		s.ActedThisRound = false
	}
}

func bettingRoundComplete(t *state.Table) bool {
	h := t.Hand
	if h == nil {
		return false
	}
	for i := 0; i < 9; i++ {
		s := t.Seats[i]
		if s == nil || !s.InHand || s.Folded || s.AllIn {
			continue
		}
		if !s.ActedThisRound {
			return false
		}
		if s.BetThisRound != h.CurrentBet {
			return false
		}
	}
	return true
}

func applyAction(t *state.Table, action string, amount uint64) *abci.ExecTxResult {
	h := t.Hand
	if h == nil {
		return &abci.ExecTxResult{Code: 1, Log: "no active hand"}
	}
	actorIdx := h.ActingSeat
	if actorIdx < 0 || actorIdx >= 9 || t.Seats[actorIdx] == nil {
		return &abci.ExecTxResult{Code: 1, Log: "invalid acting seat"}
	}
	actor := t.Seats[actorIdx]
	if actor.Folded || actor.AllIn || !actor.InHand {
		return &abci.ExecTxResult{Code: 1, Log: "actor not eligible to act"}
	}

	toCall := uint64(0)
	if actor.BetThisRound < h.CurrentBet {
		toCall = h.CurrentBet - actor.BetThisRound
	}

	events := []abci.Event{}

	switch action {
	case "fold":
		actor.Folded = true
		actor.ActedThisRound = true
	case "check":
		if toCall != 0 {
			return &abci.ExecTxResult{Code: 1, Log: "cannot check; must call/fold"}
		}
		actor.ActedThisRound = true
	case "call":
		if toCall == 0 {
			actor.ActedThisRound = true
			break
		}
		put := toCall
		if put > actor.Stack {
			put = actor.Stack
		}
		actor.Stack -= put
		actor.BetThisRound += put
		h.Pot += put
		if actor.Stack == 0 {
			actor.AllIn = true
		}
		actor.ActedThisRound = true
	case "bet":
		if h.CurrentBet != 0 {
			return &abci.ExecTxResult{Code: 1, Log: "cannot bet; use raise"}
		}
		if amount == 0 {
			return &abci.ExecTxResult{Code: 1, Log: "bet amount must be > 0"}
		}
		put := amount
		if put > actor.Stack {
			put = actor.Stack
		}
		actor.Stack -= put
		actor.BetThisRound += put
		h.Pot += put
		if actor.Stack == 0 {
			actor.AllIn = true
		}
		h.CurrentBet = actor.BetThisRound
		// A bet/raise re-opens action for others.
		for i := 0; i < 9; i++ {
			s := t.Seats[i]
			if s == nil || !s.InHand || s.Folded || s.AllIn {
				continue
			}
			s.ActedThisRound = false
		}
		actor.ActedThisRound = true
	case "raise":
		if amount == 0 {
			return &abci.ExecTxResult{Code: 1, Log: "raise amount must be > 0"}
		}
		// v0 semantics: raise amount is delta beyond the call.
		totalPut := toCall + amount
		put := totalPut
		if put > actor.Stack {
			put = actor.Stack
		}
		actor.Stack -= put
		actor.BetThisRound += put
		h.Pot += put
		if actor.Stack == 0 {
			actor.AllIn = true
		}
		if actor.BetThisRound > h.CurrentBet {
			h.CurrentBet = actor.BetThisRound
			for i := 0; i < 9; i++ {
				s := t.Seats[i]
				if s == nil || !s.InHand || s.Folded || s.AllIn {
					continue
				}
				s.ActedThisRound = false
			}
			actor.ActedThisRound = true
		} else {
			// Not actually a raise (all-in short). Treated as call.
			actor.ActedThisRound = true
		}
	default:
		return &abci.ExecTxResult{Code: 1, Log: "unknown action"}
	}

	// If only one player remains, award pot and end hand.
	if activeSeatCount(t) == 1 {
		winners := remainingActiveSeats(t)
		awardPotAndEndHand(t, winners, &events)
		return &abci.ExecTxResult{Code: 0, Events: events}
	}

	// Advance turn to next eligible seat.
	h.ActingSeat = nextActiveSeat(t, actorIdx)

	// If betting round complete, advance phase / reveal / showdown.
	if bettingRoundComplete(t) {
		switch h.Phase {
		case state.PhasePreflop:
			revealCommunityCards(t, 3, "flop", &events)
			h.Phase = state.PhaseFlop
			resetBettingRound(t)
			h.ActingSeat = firstToActPostflop(t)
		case state.PhaseFlop:
			revealCommunityCards(t, 1, "turn", &events)
			h.Phase = state.PhaseTurn
			resetBettingRound(t)
			h.ActingSeat = firstToActPostflop(t)
		case state.PhaseTurn:
			revealCommunityCards(t, 1, "river", &events)
			h.Phase = state.PhaseRiver
			resetBettingRound(t)
			h.ActingSeat = firstToActPostflop(t)
		case state.PhaseRiver:
			// Showdown (stub evaluator).
			winners := determineWinnersStub(t)
			awardPotAndEndHand(t, winners, &events)
		default:
		}
	}

	return &abci.ExecTxResult{Code: 0, Events: events}
}

func revealCommunityCards(t *state.Table, n int, street string, events *[]abci.Event) {
	h := t.Hand
	if h == nil {
		return
	}
	cards := []string{}
	for i := 0; i < n; i++ {
		if int(h.DeckCursor) >= len(h.Deck) {
			break
		}
		c := h.Deck[h.DeckCursor]
		h.DeckCursor++
		h.Board = append(h.Board, c)
		cards = append(cards, c.String())
	}
	*events = append(*events, abci.Event{
		Type: "StreetRevealed",
		Attributes: []abci.EventAttribute{
			{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
			{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
			{Key: "street", Value: street, Index: true},
			{Key: "cards", Value: strings.Join(cards, ","), Index: false},
		},
	})
}

func determineWinnersStub(t *state.Table) []int {
	h := t.Hand
	if h == nil {
		return nil
	}
	best := uint8(0)
	candidates := []int{}
	for i := 0; i < 9; i++ {
		s := t.Seats[i]
		if s == nil || !s.InHand || s.Folded {
			continue
		}
		r := bestRankHighCard(h.Board, s.Hole)
		if r > best {
			best = r
			candidates = []int{i}
		} else if r == best {
			candidates = append(candidates, i)
		}
	}
	if len(candidates) == 0 {
		return nil
	}
	return candidates
}

func bestRankHighCard(board []state.Card, hole [2]state.Card) uint8 {
	best := uint8(0)
	for _, c := range board {
		if c.Rank() > best {
			best = c.Rank()
		}
	}
	for _, c := range hole {
		if c.Rank() > best {
			best = c.Rank()
		}
	}
	return best
}

func awardPotAndEndHand(t *state.Table, winners []int, events *[]abci.Event) {
	h := t.Hand
	if h == nil {
		return
	}
	if len(winners) == 0 {
		// Shouldn't happen; burn pot to avoid stuck state.
		h.Pot = 0
		t.Hand = nil
		return
	}
	pot := h.Pot
	share := pot / uint64(len(winners))
	rem := pot % uint64(len(winners))
	for idx, seat := range winners {
		if t.Seats[seat] == nil {
			continue
		}
		t.Seats[seat].Stack += share
		if idx == 0 {
			t.Seats[seat].Stack += rem
		}
	}

	// Reset per-seat hand flags.
	for i := 0; i < 9; i++ {
		s := t.Seats[i]
		if s == nil {
			continue
		}
		s.InHand = false
		s.Folded = false
		s.AllIn = false
		s.BetThisRound = 0
		s.ActedThisRound = false
	}
	t.Hand = nil

	winnerSeats := make([]string, 0, len(winners))
	for _, w := range winners {
		winnerSeats = append(winnerSeats, fmt.Sprintf("%d", w))
	}

	*events = append(*events, abci.Event{
		Type: "HandCompleted",
		Attributes: []abci.EventAttribute{
			{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
			{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
			{Key: "winners", Value: strings.Join(winnerSeats, ","), Index: false},
			{Key: "pot", Value: fmt.Sprintf("%d", pot), Index: false},
		},
	})
}
