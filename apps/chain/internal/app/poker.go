package app

import (
	"fmt"
	"sort"
	"strings"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/holdem"
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

// nextOccupiedSeat returns the next *funded* seat (clockwise).
func nextOccupiedSeat(t *state.Table, from int) int {
	for step := 1; step <= 9; step++ {
		i := (from + step) % 9
		if t.Seats[i] != nil && t.Seats[i].Stack > 0 {
			return i
		}
	}
	return from
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

func postBlindCommit(t *state.Table, seatIdx int, amount uint64) error {
	h := t.Hand
	s := t.Seats[seatIdx]
	if h == nil || s == nil {
		return fmt.Errorf("invalid blind seat")
	}
	if !h.InHand[seatIdx] {
		return fmt.Errorf("seat not in hand")
	}
	if s.Stack == 0 {
		return fmt.Errorf("no chips")
	}

	put := amount
	if put > s.Stack {
		put = s.Stack
	}
	s.Stack -= put
	h.StreetCommit[seatIdx] += put
	h.TotalCommit[seatIdx] += put
	if s.Stack == 0 {
		h.AllIn[seatIdx] = true
	}
	return nil
}

func dealHoleCards(t *state.Table) {
	h := t.Hand
	if h == nil {
		return
	}

	// Dealing starts at the small blind seat (left of the button), or button in heads-up.
	start := h.SmallBlindSeat
	order := []int{}
	cur := start
	for {
		if h.InHand[cur] {
			order = append(order, cur)
		}
		cur = (cur + 1) % 9
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
	h := t.Hand
	if h == nil {
		return nil
	}
	events := []abci.Event{}
	for i := 0; i < 9; i++ {
		if !h.InHand[i] {
			continue
		}
		s := t.Seats[i]
		if s == nil {
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

func needsToAct(hand *state.Hand, seat int) bool {
	if !hand.InHand[seat] || hand.Folded[seat] || hand.AllIn[seat] {
		return false
	}
	interval := int(hand.IntervalID)
	return hand.LastIntervalActed[seat] != interval || hand.StreetCommit[seat] != hand.BetTo
}

func nextActiveToAct(t *state.Table, hand *state.Hand, fromSeat int) int {
	_ = t
	for step := 1; step <= 9; step++ {
		i := (fromSeat + step) % 9
		if needsToAct(hand, i) {
			return i
		}
	}
	return -1
}

func toCall(hand *state.Hand, seat int) uint64 {
	if hand.BetTo <= hand.StreetCommit[seat] {
		return 0
	}
	return hand.BetTo - hand.StreetCommit[seat]
}

func countNotFolded(hand *state.Hand) int {
	n := 0
	for i := 0; i < 9; i++ {
		if hand.InHand[i] && !hand.Folded[i] {
			n++
		}
	}
	return n
}

func countWithChips(t *state.Table, hand *state.Hand) int {
	n := 0
	for i := 0; i < 9; i++ {
		if !hand.InHand[i] || hand.Folded[i] {
			continue
		}
		s := t.Seats[i]
		if s != nil && s.Stack > 0 {
			n++
		}
	}
	return n
}

func validateRaiseAllowed(hand *state.Hand, seat int) error {
	if hand.LastIntervalActed[seat] == int(hand.IntervalID) {
		return fmt.Errorf("raise not allowed: already acted since last full raise")
	}
	return nil
}

func applyBetTo(t *state.Table, seat int, desiredCommit uint64) error {
	h := t.Hand
	if h == nil {
		return fmt.Errorf("no active hand")
	}
	s := t.Seats[seat]
	if s == nil {
		return fmt.Errorf("seat empty")
	}

	currentCommit := h.StreetCommit[seat]
	if desiredCommit <= currentCommit {
		return fmt.Errorf("BetTo must exceed current street commitment")
	}
	maxCommit := currentCommit + s.Stack
	if desiredCommit > maxCommit {
		return fmt.Errorf("BetTo exceeds available chips")
	}

	currentBetTo := h.BetTo
	if desiredCommit <= currentBetTo {
		return fmt.Errorf("BetTo must exceed current betTo (use call/check when not raising)")
	}

	isAllIn := desiredCommit == maxCommit
	if err := validateRaiseAllowed(h, seat); err != nil {
		return err
	}

	raiseSize := desiredCommit - currentBetTo
	minBet := t.Params.BigBlind

	if currentBetTo == 0 {
		// Opening bet on this street.
		if desiredCommit < minBet && !isAllIn {
			return fmt.Errorf("bet size below big blind; only allowed if all-in")
		}
		// Any opening bet creates a new betting interval, even if it's a short all-in.
		h.IntervalID += 1
		h.LastIntervalActed[seat] = int(h.IntervalID)
		if desiredCommit >= minBet {
			h.MinRaiseSize = desiredCommit
		} else {
			h.MinRaiseSize = minBet
		}
		h.BetTo = desiredCommit
	} else {
		// Raise over an existing bet.
		if raiseSize < h.MinRaiseSize {
			if !isAllIn {
				return fmt.Errorf("raise size below minimum; only allowed if all-in")
			}
			// Under-raise (all-in) does not create a new interval and does not update minRaiseSize.
			h.LastIntervalActed[seat] = int(h.IntervalID)
			h.BetTo = desiredCommit
		} else {
			// Full raise: open a new interval and update minimum raise size.
			h.IntervalID += 1
			h.MinRaiseSize = raiseSize
			h.BetTo = desiredCommit
			h.LastIntervalActed[seat] = int(h.IntervalID)
		}
	}

	delta := desiredCommit - currentCommit
	s.Stack -= delta
	h.StreetCommit[seat] += delta
	h.TotalCommit[seat] += delta
	if s.Stack == 0 {
		h.AllIn[seat] = true
	}
	return nil
}

func applyCall(t *state.Table, seat int) error {
	h := t.Hand
	if h == nil {
		return fmt.Errorf("no active hand")
	}
	s := t.Seats[seat]
	if s == nil {
		return fmt.Errorf("seat empty")
	}
	need := toCall(h, seat)
	if need == 0 {
		return fmt.Errorf("call is not legal when facing 0")
	}
	pay := need
	if pay > s.Stack {
		pay = s.Stack
	}
	s.Stack -= pay
	h.StreetCommit[seat] += pay
	h.TotalCommit[seat] += pay
	if s.Stack == 0 {
		h.AllIn[seat] = true
	}
	h.LastIntervalActed[seat] = int(h.IntervalID)
	return nil
}

func applyCheck(hand *state.Hand, seat int) error {
	if toCall(hand, seat) != 0 {
		return fmt.Errorf("check is not legal when facing a bet")
	}
	hand.LastIntervalActed[seat] = int(hand.IntervalID)
	return nil
}

func applyFold(hand *state.Hand, seat int) {
	hand.Folded[seat] = true
	hand.LastIntervalActed[seat] = int(hand.IntervalID)
}

func streetComplete(hand *state.Hand) bool {
	interval := int(hand.IntervalID)
	for i := 0; i < 9; i++ {
		if !hand.InHand[i] || hand.Folded[i] || hand.AllIn[i] {
			continue
		}
		if hand.StreetCommit[i] != hand.BetTo {
			return false
		}
		if hand.LastIntervalActed[i] != interval {
			return false
		}
	}
	return true
}

func maxCommitThisStreet(hand *state.Hand) uint64 {
	var m uint64
	for i := 0; i < 9; i++ {
		if hand.StreetCommit[i] > m {
			m = hand.StreetCommit[i]
		}
	}
	return m
}

func secondMaxCommitThisStreet(hand *state.Hand, max uint64) uint64 {
	var s uint64
	for i := 0; i < 9; i++ {
		v := hand.StreetCommit[i]
		if v == max {
			continue
		}
		if v > s {
			s = v
		}
	}
	return s
}

func returnUncalledStreetExcess(t *state.Table) {
	h := t.Hand
	if h == nil {
		return
	}

	max := maxCommitThisStreet(h)
	if max == 0 {
		return
	}
	second := secondMaxCommitThisStreet(h, max)
	if second == max {
		return
	}

	// Identify the unique max seat (if more than one seat has max, no uncalled).
	maxSeat := -1
	for i := 0; i < 9; i++ {
		if h.StreetCommit[i] != max {
			continue
		}
		if maxSeat != -1 {
			return
		}
		maxSeat = i
	}
	if maxSeat == -1 {
		return
	}

	excess := max - second
	if excess == 0 {
		return
	}
	seatState := t.Seats[maxSeat]
	if seatState == nil {
		return
	}

	seatState.Stack += excess
	h.StreetCommit[maxSeat] -= excess
	h.TotalCommit[maxSeat] -= excess
	if seatState.Stack > 0 {
		h.AllIn[maxSeat] = false
	}
}

func advanceStreet(t *state.Table, events *[]abci.Event) {
	h := t.Hand
	if h == nil {
		return
	}

	switch h.Street {
	case state.StreetPreflop:
		revealCommunityCards(t, 3, "flop", events)
		h.Street = state.StreetFlop
	case state.StreetFlop:
		revealCommunityCards(t, 1, "turn", events)
		h.Street = state.StreetTurn
	case state.StreetTurn:
		revealCommunityCards(t, 1, "river", events)
		h.Street = state.StreetRiver
	default:
		return
	}

	h.BetTo = 0
	h.MinRaiseSize = t.Params.BigBlind
	h.IntervalID = 0

	for i := 0; i < 9; i++ {
		h.StreetCommit[i] = 0
		h.LastIntervalActed[i] = -1
	}

	// Postflop action starts left of the button.
	h.ActionOn = nextActiveToAct(t, h, h.ButtonSeat)
}

func completeByFolds(t *state.Table, events *[]abci.Event) {
	h := t.Hand
	if h == nil {
		return
	}

	winnerSeat := -1
	for i := 0; i < 9; i++ {
		if h.InHand[i] && !h.Folded[i] {
			winnerSeat = i
			break
		}
	}
	if winnerSeat == -1 {
		// Should not happen; clear hand to avoid stuck state.
		t.Hand = nil
		return
	}

	// Ensure no uncalled excess remains before settlement.
	returnUncalledStreetExcess(t)

	var potTotal uint64
	for i := 0; i < 9; i++ {
		potTotal += h.TotalCommit[i]
	}
	if t.Seats[winnerSeat] != nil {
		t.Seats[winnerSeat].Stack += potTotal
	}

	handId := h.HandID
	// Clear public hole cards (DealerStub only).
	for i := 0; i < 9; i++ {
		if t.Seats[i] == nil {
			continue
		}
		t.Seats[i].Hole = [2]state.Card{}
	}
	t.Hand = nil

	*events = append(*events, abci.Event{
		Type: "HandCompleted",
		Attributes: []abci.EventAttribute{
			{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
			{Key: "handId", Value: fmt.Sprintf("%d", handId), Index: true},
			{Key: "reason", Value: "all-folded", Index: true},
			{Key: "winnerSeat", Value: fmt.Sprintf("%d", winnerSeat), Index: false},
			{Key: "pot", Value: fmt.Sprintf("%d", potTotal), Index: false},
		},
	})
}

func maybeAdvance(t *state.Table, events *[]abci.Event) {
	h := t.Hand
	if h == nil {
		return
	}

	if countNotFolded(h) <= 1 {
		completeByFolds(t, events)
		return
	}

	if !streetComplete(h) {
		h.ActionOn = nextActiveToAct(t, h, h.ActionOn)
		return
	}

	// End of betting street: return any uncalled excess, then advance.
	returnUncalledStreetExcess(t)

	if h.Street == state.StreetRiver {
		*events = append(*events, runoutAndSettleHand(t)...)
		return
	}

	// If fewer than 2 contenders still have chips, there will be no further betting (runout to showdown).
	if countWithChips(t, h) < 2 {
		*events = append(*events, runoutAndSettleHand(t)...)
		return
	}

	advanceStreet(t, events)

	// Defensive: if action is impossible after advancing (e.g., all-in), run out immediately.
	if t.Hand != nil && t.Hand.ActionOn == -1 {
		*events = append(*events, runoutAndSettleHand(t)...)
	}
}

func applyAction(t *state.Table, action string, amount uint64) *abci.ExecTxResult {
	h := t.Hand
	if h == nil {
		return &abci.ExecTxResult{Code: 1, Log: "no active hand"}
	}
	if h.Phase != state.PhaseBetting {
		return &abci.ExecTxResult{Code: 1, Log: "hand not in betting phase"}
	}

	actorIdx := h.ActionOn
	if actorIdx < 0 || actorIdx >= 9 || t.Seats[actorIdx] == nil {
		return &abci.ExecTxResult{Code: 1, Log: "invalid actionOn seat"}
	}
	if !h.InHand[actorIdx] || h.Folded[actorIdx] || h.AllIn[actorIdx] {
		return &abci.ExecTxResult{Code: 1, Log: "actor not eligible to act"}
	}

	need := toCall(h, actorIdx)

	switch action {
	case "fold":
		applyFold(h, actorIdx)
	case "check":
		if err := applyCheck(h, actorIdx); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
	case "call":
		if err := applyCall(t, actorIdx); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
	case "bet":
		if h.BetTo != 0 {
			return &abci.ExecTxResult{Code: 1, Log: "cannot bet; use raise"}
		}
		if amount == 0 {
			return &abci.ExecTxResult{Code: 1, Log: "bet amount must be > 0"}
		}
		if err := applyBetTo(t, actorIdx, amount); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
	case "raise":
		if h.BetTo == 0 {
			return &abci.ExecTxResult{Code: 1, Log: "cannot raise; use bet"}
		}
		if amount == 0 {
			return &abci.ExecTxResult{Code: 1, Log: "raise amount must be > 0"}
		}
		if err := applyBetTo(t, actorIdx, amount); err != nil {
			return &abci.ExecTxResult{Code: 1, Log: err.Error()}
		}
	default:
		return &abci.ExecTxResult{Code: 1, Log: "unknown action"}
	}

	// Advance / reveal / settle.
	events := []abci.Event{}
	_ = need // reserved for future event payloads
	maybeAdvance(t, &events)

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

func sameSeats(a []int, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := 0; i < len(a); i++ {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func computeSidePots(totalCommit [9]uint64, eligibleForWin [9]bool) []state.Pot {
	type rem struct {
		seat     int
		amount   uint64
		eligible bool
	}
	remaining := make([]rem, 0, 9)
	for i := 0; i < 9; i++ {
		amt := totalCommit[i]
		if amt == 0 {
			continue
		}
		remaining = append(remaining, rem{seat: i, amount: amt, eligible: eligibleForWin[i]})
	}

	potsByTier := []state.Pot{}
	for len(remaining) > 0 {
		min := remaining[0].amount
		for i := 1; i < len(remaining); i++ {
			if remaining[i].amount < min {
				min = remaining[i].amount
			}
		}

		potAmount := min * uint64(len(remaining))
		eligibleSeats := make([]int, 0, len(remaining))
		for _, r := range remaining {
			if r.eligible {
				eligibleSeats = append(eligibleSeats, r.seat)
			}
		}
		potsByTier = append(potsByTier, state.Pot{Amount: potAmount, EligibleSeats: eligibleSeats})

		next := remaining[:0]
		for _, r := range remaining {
			r.amount -= min
			if r.amount > 0 {
				next = append(next, r)
			}
		}
		remaining = next
	}

	merged := []state.Pot{}
	for _, p := range potsByTier {
		if len(merged) > 0 && sameSeats(merged[len(merged)-1].EligibleSeats, p.EligibleSeats) {
			merged[len(merged)-1].Amount += p.Amount
			continue
		}
		eligibleCopy := append([]int(nil), p.EligibleSeats...)
		merged = append(merged, state.Pot{Amount: p.Amount, EligibleSeats: eligibleCopy})
	}
	return merged
}

func joinSeats(seats []int) string {
	if len(seats) == 0 {
		return ""
	}
	parts := make([]string, 0, len(seats))
	for _, s := range seats {
		parts = append(parts, fmt.Sprintf("%d", s))
	}
	return strings.Join(parts, ",")
}

func runoutAndSettleHand(t *state.Table) []abci.Event {
	h := t.Hand
	if h == nil {
		return nil
	}

	events := []abci.Event{}

	// Mark showdown and run out any missing board cards.
	h.Phase = state.PhaseShowdown
	h.ActionOn = -1

	switch h.Street {
	case state.StreetPreflop:
		revealCommunityCards(t, 3, "flop", &events)
		h.Street = state.StreetFlop
		fallthrough
	case state.StreetFlop:
		revealCommunityCards(t, 1, "turn", &events)
		h.Street = state.StreetTurn
		fallthrough
	case state.StreetTurn:
		revealCommunityCards(t, 1, "river", &events)
		h.Street = state.StreetRiver
	case state.StreetRiver:
	default:
	}

	// Defensive: ensure 5 board cards if possible.
	for len(h.Board) < 5 && int(h.DeckCursor) < len(h.Deck) {
		revealCommunityCards(t, 1, "runout", &events)
	}

	var eligible [9]bool
	for i := 0; i < 9; i++ {
		eligible[i] = h.InHand[i] && !h.Folded[i]
	}

	pots := computeSidePots(h.TotalCommit, eligible)
	h.Pots = pots

	events = append(events, abci.Event{
		Type: "ShowdownReached",
		Attributes: []abci.EventAttribute{
			{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
			{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
			{Key: "pots", Value: fmt.Sprintf("%d", len(pots)), Index: false},
		},
	})

	board5 := h.Board
	if len(board5) > 5 {
		board5 = board5[:5]
	}

	potWinners := make([][]int, len(pots))
	for potIdx, pot := range pots {
		if pot.Amount == 0 || len(pot.EligibleSeats) == 0 {
			continue
		}

		holeBySeat := make(map[int][2]state.Card, len(pot.EligibleSeats))
		for _, seat := range pot.EligibleSeats {
			if seat < 0 || seat > 8 {
				continue
			}
			s := t.Seats[seat]
			if s == nil {
				continue
			}
			holeBySeat[seat] = s.Hole
		}

		if len(pot.EligibleSeats) == 1 {
			potWinners[potIdx] = []int{pot.EligibleSeats[0]}
		} else {
			winners, err := holdem.Winners(board5, holeBySeat)
			if err != nil {
				// Something is inconsistent (duplicate cards, invalid ids). Refund all commits and abort.
				for i := 0; i < 9; i++ {
					if t.Seats[i] == nil {
						continue
					}
					t.Seats[i].Stack += h.TotalCommit[i]
				}
				handId := h.HandID
				for i := 0; i < 9; i++ {
					if t.Seats[i] == nil {
						continue
					}
					t.Seats[i].Hole = [2]state.Card{}
				}
				t.Hand = nil
				events = append(events, abci.Event{
					Type: "HandAborted",
					Attributes: []abci.EventAttribute{
						{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
						{Key: "handId", Value: fmt.Sprintf("%d", handId), Index: true},
						{Key: "reason", Value: "showdown-eval-error: " + err.Error(), Index: false},
					},
				})
				return events
			}
			potWinners[potIdx] = winners
		}
	}

	// Award pots.
	for potIdx, pot := range pots {
		winners := potWinners[potIdx]
		if pot.Amount == 0 || len(pot.EligibleSeats) == 0 || len(winners) == 0 {
			continue
		}
		share := pot.Amount / uint64(len(winners))
		rem := pot.Amount % uint64(len(winners))
		for i, seat := range winners {
			if t.Seats[seat] == nil {
				continue
			}
			t.Seats[seat].Stack += share
			if i == 0 {
				t.Seats[seat].Stack += rem
			}
		}

		events = append(events, abci.Event{
			Type: "PotAwarded",
			Attributes: []abci.EventAttribute{
				{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
				{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
				{Key: "potIndex", Value: fmt.Sprintf("%d", potIdx), Index: true},
				{Key: "amount", Value: fmt.Sprintf("%d", pot.Amount), Index: false},
				{Key: "eligibleSeats", Value: joinSeats(pot.EligibleSeats), Index: false},
				{Key: "winners", Value: joinSeats(winners), Index: false},
			},
		})
	}

	handId := h.HandID
	// Clear public hole cards (DealerStub only).
	for i := 0; i < 9; i++ {
		if t.Seats[i] == nil {
			continue
		}
		t.Seats[i].Hole = [2]state.Card{}
	}
	t.Hand = nil

	events = append(events, abci.Event{
		Type: "HandCompleted",
		Attributes: []abci.EventAttribute{
			{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
			{Key: "handId", Value: fmt.Sprintf("%d", handId), Index: true},
			{Key: "reason", Value: "showdown", Index: true},
		},
	})

	return events
}
