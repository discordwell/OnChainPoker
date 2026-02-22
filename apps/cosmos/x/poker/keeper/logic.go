package keeper

import (
	"fmt"
	"sort"
	"strings"

	"onchainpoker/apps/cosmos/internal/cards"
	"onchainpoker/apps/cosmos/internal/holdem"
	"onchainpoker/apps/cosmos/x/poker/types"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

const (
	defaultDealerTimeoutSecs uint64 = 120
	defaultActionTimeoutSecs uint64 = 30
)

// autoAssignSeat picks the first empty seat clockwise after the current big blind.
// On a fresh table (ButtonSeat == -1, no hand), it returns the first empty seat.
// The placement ensures the new player will be next up for the big blind.
func autoAssignSeat(t *types.Table) (int, error) {
	max := int(t.Params.MaxPlayers)
	if max == 0 {
		max = 9
	}

	// Fresh table: assign first empty seat.
	if t.ButtonSeat < 0 && t.Hand == nil {
		for i := 0; i < max; i++ {
			if t.Seats[i] == nil || t.Seats[i].Player == "" {
				return i, nil
			}
		}
		return -1, fmt.Errorf("table full")
	}

	// Determine BB position to walk clockwise from.
	var bbSeat int
	if t.Hand != nil {
		bbSeat = int(t.Hand.BigBlindSeat)
	} else {
		// No hand active but button is set — compute would-be BB.
		_, bb := blindSeats(t)
		if bb >= 0 {
			bbSeat = bb
		} else {
			bbSeat = int(t.ButtonSeat)
		}
	}

	// Walk clockwise from BB+1 looking for an empty seat.
	for step := 1; step <= max; step++ {
		i := (bbSeat + step) % max
		if t.Seats[i] == nil || t.Seats[i].Player == "" {
			return i, nil
		}
	}
	return -1, fmt.Errorf("table full")
}

func occupiedSeatsWithStack(t *types.Table) []int {
	out := make([]int, 0, 9)
	for i := 0; i < 9; i++ {
		if i >= len(t.Seats) || t.Seats[i] == nil {
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

func seatOfPlayer(t *types.Table, player string) int {
	if t == nil || player == "" {
		return -1
	}
	for i := 0; i < 9; i++ {
		if i >= len(t.Seats) {
			continue
		}
		if t.Seats[i] == nil {
			continue
		}
		if t.Seats[i].Player == player {
			return i
		}
	}
	return -1
}

// nextOccupiedSeat returns the next *funded* seat (clockwise).
func nextOccupiedSeat(t *types.Table, from int) int {
	for step := 1; step <= 9; step++ {
		i := (from + step) % 9
		if i >= len(t.Seats) {
			continue
		}
		if t.Seats[i] != nil && t.Seats[i].Stack > 0 {
			return i
		}
	}
	return from
}

func blindSeats(t *types.Table) (sbSeat int, bbSeat int) {
	active := occupiedSeatsWithStack(t)
	if len(active) < 2 {
		return -1, -1
	}
	if len(active) == 2 {
		// Heads-up: button posts SB.
		sbSeat = int(t.ButtonSeat)
		bbSeat = nextOccupiedSeat(t, sbSeat)
		return sbSeat, bbSeat
	}
	sbSeat = nextOccupiedSeat(t, int(t.ButtonSeat))
	bbSeat = nextOccupiedSeat(t, sbSeat)
	return sbSeat, bbSeat
}

func postBlindCommit(t *types.Table, seatIdx int, amount uint64) error {
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
	nextStreetCommit, err := addUint64Checked(h.StreetCommit[seatIdx], put, "street commit")
	if err != nil {
		return err
	}
	nextTotalCommit, err := addUint64Checked(h.TotalCommit[seatIdx], put, "total commit")
	if err != nil {
		return err
	}
	s.Stack -= put
	h.StreetCommit[seatIdx] = nextStreetCommit
	h.TotalCommit[seatIdx] = nextTotalCommit
	if s.Stack == 0 {
		h.AllIn[seatIdx] = true
	}
	return nil
}

func needsToAct(hand *types.Hand, seat int) bool {
	if !hand.InHand[seat] || hand.Folded[seat] || hand.AllIn[seat] {
		return false
	}
	interval := int32(hand.IntervalId)
	return hand.LastIntervalActed[seat] != interval || hand.StreetCommit[seat] != hand.BetTo
}

func nextActiveToAct(t *types.Table, hand *types.Hand, fromSeat int) int {
	_ = t
	for step := 1; step <= 9; step++ {
		i := (fromSeat + step) % 9
		if needsToAct(hand, i) {
			return i
		}
	}
	return -1
}

func toCall(hand *types.Hand, seat int) uint64 {
	if hand.BetTo <= hand.StreetCommit[seat] {
		return 0
	}
	return hand.BetTo - hand.StreetCommit[seat]
}

func countNotFolded(hand *types.Hand) int {
	n := 0
	for i := 0; i < 9; i++ {
		if hand.InHand[i] && !hand.Folded[i] {
			n++
		}
	}
	return n
}

func countWithChips(t *types.Table, hand *types.Hand) int {
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

func validateRaiseAllowed(hand *types.Hand, seat int) error {
	if hand.LastIntervalActed[seat] == int32(hand.IntervalId) {
		return fmt.Errorf("raise not allowed: already acted since last full raise")
	}
	return nil
}

func applyBetTo(t *types.Table, seat int, desiredCommit uint64) error {
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
	maxCommit, err := addUint64Checked(currentCommit, s.Stack, "max commit")
	if err != nil {
		return err
	}
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
		h.IntervalId += 1
		h.LastIntervalActed[seat] = int32(h.IntervalId)
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
			h.LastIntervalActed[seat] = int32(h.IntervalId)
			h.BetTo = desiredCommit
		} else {
			// Full raise: open a new interval and update minimum raise size.
			h.IntervalId += 1
			h.MinRaiseSize = raiseSize
			h.BetTo = desiredCommit
			h.LastIntervalActed[seat] = int32(h.IntervalId)
		}
	}

	delta := desiredCommit - currentCommit
	nextStreetCommit, err := addUint64Checked(h.StreetCommit[seat], delta, "street commit")
	if err != nil {
		return err
	}
	nextTotalCommit, err := addUint64Checked(h.TotalCommit[seat], delta, "total commit")
	if err != nil {
		return err
	}
	s.Stack -= delta
	h.StreetCommit[seat] = nextStreetCommit
	h.TotalCommit[seat] = nextTotalCommit
	if s.Stack == 0 {
		h.AllIn[seat] = true
	}
	return nil
}

func applyCall(t *types.Table, seat int) error {
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
	nextStreetCommit, err := addUint64Checked(h.StreetCommit[seat], pay, "street commit")
	if err != nil {
		return err
	}
	nextTotalCommit, err := addUint64Checked(h.TotalCommit[seat], pay, "total commit")
	if err != nil {
		return err
	}
	s.Stack -= pay
	h.StreetCommit[seat] = nextStreetCommit
	h.TotalCommit[seat] = nextTotalCommit
	if s.Stack == 0 {
		h.AllIn[seat] = true
	}
	h.LastIntervalActed[seat] = int32(h.IntervalId)
	return nil
}

func applyCheck(hand *types.Hand, seat int) error {
	if toCall(hand, seat) != 0 {
		return fmt.Errorf("check is not legal when facing a bet")
	}
	hand.LastIntervalActed[seat] = int32(hand.IntervalId)
	return nil
}

func applyFold(hand *types.Hand, seat int) {
	hand.Folded[seat] = true
	hand.LastIntervalActed[seat] = int32(hand.IntervalId)
}

func streetComplete(hand *types.Hand) bool {
	interval := int32(hand.IntervalId)
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

func maxCommitThisStreet(hand *types.Hand) uint64 {
	var m uint64
	for i := 0; i < 9; i++ {
		if hand.StreetCommit[i] > m {
			m = hand.StreetCommit[i]
		}
	}
	return m
}

func secondMaxCommitThisStreet(hand *types.Hand, max uint64) uint64 {
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

func returnUncalledStreetExcess(t *types.Table) error {
	h := t.Hand
	if h == nil {
		return nil
	}

	max := maxCommitThisStreet(h)
	if max == 0 {
		return nil
	}
	second := secondMaxCommitThisStreet(h, max)
	if second == max {
		return nil
	}

	// Identify the unique max seat (if more than one seat has max, no uncalled).
	maxSeat := -1
	for i := 0; i < 9; i++ {
		if h.StreetCommit[i] != max {
			continue
		}
		if maxSeat != -1 {
			return nil
		}
		maxSeat = i
	}
	if maxSeat == -1 {
		return nil
	}

	excess := max - second
	if excess == 0 {
		return nil
	}
	seatState := t.Seats[maxSeat]
	if seatState == nil {
		return nil
	}
	nextStack, err := addUint64Checked(seatState.Stack, excess, "seat stack")
	if err != nil {
		return err
	}
	if h.StreetCommit[maxSeat] < excess {
		return fmt.Errorf("street commit underflow on uncalled excess return")
	}
	if h.TotalCommit[maxSeat] < excess {
		return fmt.Errorf("total commit underflow on uncalled excess return")
	}
	seatState.Stack = nextStack
	h.StreetCommit[maxSeat] -= excess
	h.TotalCommit[maxSeat] -= excess
	if seatState.Stack > 0 {
		h.AllIn[maxSeat] = false
	}
	return nil
}

func completeByFolds(t *types.Table, events *[]sdk.Event) error {
	h := t.Hand
	if h == nil {
		return nil
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
		return nil
	}

	// Ensure no uncalled excess remains before settlement.
	if err := returnUncalledStreetExcess(t); err != nil {
		return err
	}

	var potTotal uint64
	for i := 0; i < 9; i++ {
		nextPot, err := addUint64Checked(potTotal, h.TotalCommit[i], "pot total")
		if err != nil {
			return err
		}
		potTotal = nextPot
	}
	if t.Seats[winnerSeat] != nil {
		nextStack, err := addUint64Checked(t.Seats[winnerSeat].Stack, potTotal, "winner stack")
		if err != nil {
			return err
		}
		t.Seats[winnerSeat].Stack = nextStack
	}

	handId := h.HandId

	// Clear public hole cards.
	for i := 0; i < 9; i++ {
		if t.Seats[i] == nil {
			continue
		}
		t.Seats[i].Hole = []uint32{255, 255}
	}
	t.Hand = nil

	*events = append(*events, sdk.NewEvent(
		types.EventTypeHandCompleted,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", t.Id)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", handId)),
		sdk.NewAttribute("reason", "all-folded"),
		sdk.NewAttribute("winnerSeat", fmt.Sprintf("%d", winnerSeat)),
		sdk.NewAttribute("pot", fmt.Sprintf("%d", potTotal)),
	))
	return nil
}

func maybeAdvance(t *types.Table, events *[]sdk.Event) error {
	h := t.Hand
	if h == nil {
		return nil
	}

	if countNotFolded(h) <= 1 {
		return completeByFolds(t, events)
	}

	if !streetComplete(h) {
		h.ActionOn = int32(nextActiveToAct(t, h, int(h.ActionOn)))
		return nil
	}

	// End of betting street: return any uncalled excess, then advance.
	if err := returnUncalledStreetExcess(t); err != nil {
		return err
	}

	// Dealer mode: do not reveal from a plaintext deck. Enter a reveal phase and require
	// x/dealer to append the next public cards.
	if h.Dealer != nil {
		h.ActionOn = -1
		switch h.Street {
		case types.Street_STREET_PREFLOP:
			h.Phase = types.HandPhase_HAND_PHASE_AWAIT_FLOP
		case types.Street_STREET_FLOP:
			h.Phase = types.HandPhase_HAND_PHASE_AWAIT_TURN
		case types.Street_STREET_TURN:
			h.Phase = types.HandPhase_HAND_PHASE_AWAIT_RIVER
		case types.Street_STREET_RIVER:
			h.Phase = types.HandPhase_HAND_PHASE_AWAIT_SHOWDOWN
		default:
			h.Phase = types.HandPhase_HAND_PHASE_AWAIT_SHOWDOWN
		}
		return nil
	}
	return nil
}

func appendStreetRevealedEvent(t *types.Table, street string, cardsIn []cards.Card, events *[]sdk.Event) {
	h := t.Hand
	if h == nil {
		return
	}
	cardStrs := make([]string, 0, len(cardsIn))
	for _, c := range cardsIn {
		cardStrs = append(cardStrs, c.String())
	}
	*events = append(*events, sdk.NewEvent(
		types.EventTypeStreetRevealed,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", t.Id)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", h.HandId)),
		sdk.NewAttribute("street", street),
		sdk.NewAttribute("cards", strings.Join(cardStrs, ",")),
	))
}

func dealerEligibleShowdownHolePositions(t *types.Table) ([]uint32, error) {
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, fmt.Errorf("missing dealer meta")
	}
	h := t.Hand
	dh := h.Dealer
	if len(dh.HolePos) != 18 {
		return nil, fmt.Errorf("holePos not initialized")
	}

	pos := make([]uint32, 0, 18)
	for seat := 0; seat < 9; seat++ {
		if !h.InHand[seat] || h.Folded[seat] {
			continue
		}
		for c := 0; c < 2; c++ {
			p := dh.HolePos[seat*2+c]
			if p == 255 {
				return nil, fmt.Errorf("holePos unset for seat %d", seat)
			}
			pos = append(pos, p)
		}
	}

	sort.Slice(pos, func(i, j int) bool { return pos[i] < pos[j] })
	return pos, nil
}

func dealerNextShowdownHolePos(t *types.Table) (uint32, bool, error) {
	pos, err := dealerEligibleShowdownHolePositions(t)
	if err != nil {
		return 0, false, err
	}
	dh := t.Hand.Dealer
	for _, p := range pos {
		seat, holeIdx, ok := dealerPosToSeatHole(dh.HolePos, p)
		if !ok {
			continue
		}
		if seat < 0 || seat >= len(t.Seats) || t.Seats[seat] == nil {
			continue
		}
		if holeIdx < 0 || holeIdx > 1 {
			continue
		}
		if len(t.Seats[seat].Hole) != 2 {
			continue
		}
		if t.Seats[seat].Hole[holeIdx] == 255 {
			return p, true, nil
		}
	}
	return 0, false, nil
}

func dealerPosToSeatHole(holePos []uint32, pos uint32) (seat int, holeIdx int, ok bool) {
	if len(holePos) != 18 {
		return -1, -1, false
	}
	for s := 0; s < 9; s++ {
		for c := 0; c < 2; c++ {
			if holePos[s*2+c] == pos {
				return s, c, true
			}
		}
	}
	return -1, -1, false
}

func dealerExpectedRevealPos(t *types.Table) (uint32, bool, error) {
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return 0, false, nil
	}
	h := t.Hand
	dh := h.Dealer
	if !dh.DeckFinalized {
		return 0, false, fmt.Errorf("deck not finalized")
	}
	if dh.DeckSize == 0 {
		return 0, false, fmt.Errorf("empty dealer deck")
	}

	switch h.Phase {
	case types.HandPhase_HAND_PHASE_AWAIT_FLOP:
		if len(h.Board) > 2 {
			return 0, false, fmt.Errorf("awaitFlop but board has %d cards", len(h.Board))
		}
		pos := dh.Cursor + uint32(len(h.Board))
		if pos >= dh.DeckSize {
			return 0, false, fmt.Errorf("board pos out of bounds")
		}
		return pos, true, nil
	case types.HandPhase_HAND_PHASE_AWAIT_TURN:
		if len(h.Board) != 3 {
			return 0, false, fmt.Errorf("awaitTurn but board has %d cards", len(h.Board))
		}
		pos := dh.Cursor + uint32(len(h.Board))
		if pos >= dh.DeckSize {
			return 0, false, fmt.Errorf("board pos out of bounds")
		}
		return pos, true, nil
	case types.HandPhase_HAND_PHASE_AWAIT_RIVER:
		if len(h.Board) != 4 {
			return 0, false, fmt.Errorf("awaitRiver but board has %d cards", len(h.Board))
		}
		pos := dh.Cursor + uint32(len(h.Board))
		if pos >= dh.DeckSize {
			return 0, false, fmt.Errorf("board pos out of bounds")
		}
		return pos, true, nil
	case types.HandPhase_HAND_PHASE_AWAIT_SHOWDOWN:
		if len(h.Board) != 5 {
			return 0, false, fmt.Errorf("awaitShowdown but board has %d cards", len(h.Board))
		}
		p, ok, err := dealerNextShowdownHolePos(t)
		if err != nil {
			return 0, false, err
		}
		if !ok {
			return 0, false, nil
		}
		return p, true, nil
	default:
		return 0, false, nil
	}
}

func resetPostflopBettingRound(t *types.Table) {
	h := t.Hand
	if h == nil {
		return
	}
	h.BetTo = 0
	h.MinRaiseSize = t.Params.BigBlind
	h.IntervalId = 0
	for i := 0; i < 9; i++ {
		h.StreetCommit[i] = 0
		h.LastIntervalActed[i] = -1
	}
	// Postflop action starts left of the button.
	h.ActionOn = int32(nextActiveToAct(t, h, int(h.ButtonSeat)))
}

// applyDealerRevealToPoker mutates table/hand state in response to a dealer reveal.
// The caller is responsible for persisting the table and emitting the returned events.
func applyDealerRevealToPoker(t *types.Table, pos uint32, cardID uint32, nowUnix int64) ([]sdk.Event, error) {
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, nil
	}
	h := t.Hand
	dh := h.Dealer

	events := []sdk.Event{}

	switch h.Phase {
	case types.HandPhase_HAND_PHASE_AWAIT_FLOP, types.HandPhase_HAND_PHASE_AWAIT_TURN, types.HandPhase_HAND_PHASE_AWAIT_RIVER:
		if !dh.DeckFinalized {
			return nil, fmt.Errorf("deck not finalized")
		}
		expectPos := dh.Cursor + uint32(len(h.Board))
		if pos != expectPos {
			return nil, fmt.Errorf("unexpected reveal pos: expected %d got %d", expectPos, pos)
		}
		h.Board = append(h.Board, cardID)
		switch h.Phase {
		case types.HandPhase_HAND_PHASE_AWAIT_FLOP:
			if len(h.Board) == 3 {
				appendStreetRevealedEvent(t, "flop", []cards.Card{cards.Card(h.Board[0]), cards.Card(h.Board[1]), cards.Card(h.Board[2])}, &events)
				h.Street = types.Street_STREET_FLOP
				if countWithChips(t, h) < 2 {
					h.Phase = types.HandPhase_HAND_PHASE_AWAIT_TURN
					h.ActionOn = -1
				} else {
					h.Phase = types.HandPhase_HAND_PHASE_BETTING
					resetPostflopBettingRound(t)
				}
			}
		case types.HandPhase_HAND_PHASE_AWAIT_TURN:
			if len(h.Board) == 4 {
				appendStreetRevealedEvent(t, "turn", []cards.Card{cards.Card(h.Board[3])}, &events)
				h.Street = types.Street_STREET_TURN
				if countWithChips(t, h) < 2 {
					h.Phase = types.HandPhase_HAND_PHASE_AWAIT_RIVER
					h.ActionOn = -1
				} else {
					h.Phase = types.HandPhase_HAND_PHASE_BETTING
					resetPostflopBettingRound(t)
				}
			}
		case types.HandPhase_HAND_PHASE_AWAIT_RIVER:
			if len(h.Board) == 5 {
				appendStreetRevealedEvent(t, "river", []cards.Card{cards.Card(h.Board[4])}, &events)
				h.Street = types.Street_STREET_RIVER
				if countWithChips(t, h) < 2 {
					h.Phase = types.HandPhase_HAND_PHASE_AWAIT_SHOWDOWN
					h.ActionOn = -1
				} else {
					h.Phase = types.HandPhase_HAND_PHASE_BETTING
					resetPostflopBettingRound(t)
				}
			}
		}

		// Deadlines updated by caller via setRevealDeadlineIfAwaiting / setActionDeadlineIfBetting.
		_ = nowUnix
		return events, nil

	case types.HandPhase_HAND_PHASE_AWAIT_SHOWDOWN:
		seat, holeIdx, ok := dealerPosToSeatHole(dh.HolePos, pos)
		if !ok || seat < 0 || seat >= 9 || holeIdx < 0 || holeIdx > 1 || t.Seats[seat] == nil {
			return nil, fmt.Errorf("pos %d is not a revealable hole card", pos)
		}

		// Gate: only reveal for eligible (in-hand, not folded) seats.
		if !h.InHand[seat] || h.Folded[seat] {
			return nil, fmt.Errorf("seat %d not eligible for showdown reveal", seat)
		}

		if len(t.Seats[seat].Hole) != 2 {
			t.Seats[seat].Hole = []uint32{255, 255}
		}
		t.Seats[seat].Hole[holeIdx] = cardID

		events = append(events, sdk.NewEvent(
			types.EventTypeHoleCardRevealed,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", t.Id)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", h.HandId)),
			sdk.NewAttribute("seat", fmt.Sprintf("%d", seat)),
			sdk.NewAttribute("player", t.Seats[seat].Player),
			sdk.NewAttribute("card", cards.Card(cardID).String()),
		))

		// If all eligible hole cards are now public, settle immediately.
		if _, more, err := dealerNextShowdownHolePos(t); err != nil {
			return nil, err
		} else if !more {
			showdownEvents, err := settleKnownShowdown(t)
			if err != nil {
				return nil, err
			}
			events = append(events, showdownEvents...)
		}

		return events, nil
	default:
		return nil, fmt.Errorf("hand not in an await phase")
	}
}

type sidePot struct {
	Amount        uint64
	EligibleSeats []int
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

func computeSidePots(totalCommit []uint64, eligibleForWin []bool) ([]sidePot, error) {
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

	potsByTier := []sidePot{}
	for len(remaining) > 0 {
		min := remaining[0].amount
		for i := 1; i < len(remaining); i++ {
			if remaining[i].amount < min {
				min = remaining[i].amount
			}
		}

		potAmount, err := mulUint64Checked(min, uint64(len(remaining)), "pot amount")
		if err != nil {
			return nil, err
		}
		eligibleSeats := make([]int, 0, len(remaining))
		for _, r := range remaining {
			if r.eligible {
				eligibleSeats = append(eligibleSeats, r.seat)
			}
		}
		potsByTier = append(potsByTier, sidePot{Amount: potAmount, EligibleSeats: eligibleSeats})

		next := remaining[:0]
		for _, r := range remaining {
			r.amount -= min
			if r.amount > 0 {
				next = append(next, r)
			}
		}
		remaining = next
	}

	merged := []sidePot{}
	for _, p := range potsByTier {
		if len(merged) > 0 && sameSeats(merged[len(merged)-1].EligibleSeats, p.EligibleSeats) {
			nextAmt, err := addUint64Checked(merged[len(merged)-1].Amount, p.Amount, "merged pot amount")
			if err != nil {
				return nil, err
			}
			merged[len(merged)-1].Amount = nextAmt
			continue
		}
		eligibleCopy := append([]int(nil), p.EligibleSeats...)
		merged = append(merged, sidePot{Amount: p.Amount, EligibleSeats: eligibleCopy})
	}
	return merged, nil
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

func settleKnownShowdown(t *types.Table) ([]sdk.Event, error) {
	h := t.Hand
	if h == nil {
		return nil, nil
	}

	events := []sdk.Event{}

	h.Phase = types.HandPhase_HAND_PHASE_SHOWDOWN
	h.ActionOn = -1

	if len(h.Board) < 5 {
		handId := h.HandId
		t.Hand = nil
		events = append(events, sdk.NewEvent(
			types.EventTypeHandAborted,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", t.Id)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", handId)),
			sdk.NewAttribute("reason", "missing board cards"),
		))
		return events, nil
	}

	eligible := make([]bool, 9)
	for i := 0; i < 9; i++ {
		eligible[i] = h.InHand[i] && !h.Folded[i]
	}

	pots, err := computeSidePots(h.TotalCommit, eligible)
	if err != nil {
		return nil, err
	}

	events = append(events, sdk.NewEvent(
		types.EventTypeShowdownReached,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", t.Id)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", h.HandId)),
		sdk.NewAttribute("pots", fmt.Sprintf("%d", len(pots))),
	))

	board5 := h.Board
	if len(board5) > 5 {
		board5 = board5[:5]
	}

	potWinners := make([][]int, len(pots))
	for potIdx, pot := range pots {
		if pot.Amount == 0 || len(pot.EligibleSeats) == 0 {
			continue
		}

		holeBySeat := make(map[int][2]cards.Card, len(pot.EligibleSeats))
		for _, seat := range pot.EligibleSeats {
			if seat < 0 || seat > 8 {
				continue
			}
			s := t.Seats[seat]
			if s == nil || len(s.Hole) != 2 {
				continue
			}
			if s.Hole[0] == 255 || s.Hole[1] == 255 {
				continue
			}
			holeBySeat[seat] = [2]cards.Card{cards.Card(s.Hole[0]), cards.Card(s.Hole[1])}
		}

		if len(pot.EligibleSeats) == 1 {
			potWinners[potIdx] = []int{pot.EligibleSeats[0]}
		} else {
			winners, err := holdem.Winners(
				[]cards.Card{cards.Card(board5[0]), cards.Card(board5[1]), cards.Card(board5[2]), cards.Card(board5[3]), cards.Card(board5[4])},
				holeBySeat,
			)
			if err != nil {
				// Something is inconsistent (duplicate cards, missing hole cards, invalid ids).
				// Refund all commits and abort.
				for i := 0; i < 9; i++ {
					if t.Seats[i] == nil {
						continue
					}
					nextStack, addErr := addUint64Checked(t.Seats[i].Stack, h.TotalCommit[i], "seat stack refund")
					if addErr != nil {
						return nil, addErr
					}
					t.Seats[i].Stack = nextStack
				}
				handId := h.HandId
				for i := 0; i < 9; i++ {
					if t.Seats[i] == nil {
						continue
					}
					t.Seats[i].Hole = []uint32{255, 255}
				}
				t.Hand = nil
				events = append(events, sdk.NewEvent(
					types.EventTypeHandAborted,
					sdk.NewAttribute("tableId", fmt.Sprintf("%d", t.Id)),
					sdk.NewAttribute("handId", fmt.Sprintf("%d", handId)),
					sdk.NewAttribute("reason", "showdown-eval-error: "+err.Error()),
				))
				return events, nil
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
			nextStack, err := addUint64Checked(t.Seats[seat].Stack, share, "seat stack award")
			if err != nil {
				return nil, err
			}
			t.Seats[seat].Stack = nextStack
			if i == 0 {
				nextStack, err = addUint64Checked(t.Seats[seat].Stack, rem, "seat stack remainder award")
				if err != nil {
					return nil, err
				}
				t.Seats[seat].Stack = nextStack
			}
		}

		events = append(events, sdk.NewEvent(
			types.EventTypePotAwarded,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", t.Id)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", h.HandId)),
			sdk.NewAttribute("potIndex", fmt.Sprintf("%d", potIdx)),
			sdk.NewAttribute("amount", fmt.Sprintf("%d", pot.Amount)),
			sdk.NewAttribute("eligibleSeats", joinSeats(pot.EligibleSeats)),
			sdk.NewAttribute("winners", joinSeats(winners)),
		))
	}

	handId := h.HandId
	// Clear public hole cards (showdown reveal).
	for i := 0; i < 9; i++ {
		if t.Seats[i] == nil {
			continue
		}
		t.Seats[i].Hole = []uint32{255, 255}
	}
	t.Hand = nil

	events = append(events, sdk.NewEvent(
		types.EventTypeHandCompleted,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", t.Id)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", handId)),
		sdk.NewAttribute("reason", "showdown"),
	))
	return events, nil
}

func tableDealerTimeoutSecs(t *types.Table) uint64 {
	if t == nil {
		return defaultDealerTimeoutSecs
	}
	if t.Params.DealerTimeoutSecs == 0 {
		return defaultDealerTimeoutSecs
	}
	return t.Params.DealerTimeoutSecs
}

func tableActionTimeoutSecs(t *types.Table) uint64 {
	if t == nil {
		return defaultActionTimeoutSecs
	}
	if t.Params.ActionTimeoutSecs == 0 {
		return defaultActionTimeoutSecs
	}
	return t.Params.ActionTimeoutSecs
}

func setRevealDeadlineIfAwaiting(t *types.Table, nowUnix int64) error {
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil
	}
	dh := t.Hand.Dealer

	pos, awaiting, err := dealerExpectedRevealPos(t)
	if err != nil {
		return err
	}
	if !awaiting {
		dh.RevealPos = 255
		dh.RevealDeadline = 0
		return nil
	}

	to := tableDealerTimeoutSecs(t)
	if to == 0 {
		return fmt.Errorf("invalid dealerTimeoutSecs")
	}
	dh.RevealPos = pos
	deadline, err := addInt64AndU64Checked(nowUnix, to, "reveal deadline")
	if err != nil {
		return err
	}
	dh.RevealDeadline = deadline
	return nil
}

func setActionDeadlineIfBetting(t *types.Table, nowUnix int64) error {
	if t == nil || t.Hand == nil {
		return nil
	}
	h := t.Hand

	// Clear deadline outside of betting (no player action).
	if h.Phase != types.HandPhase_HAND_PHASE_BETTING || h.ActionOn < 0 || h.ActionOn >= 9 {
		h.ActionDeadline = 0
		return nil
	}

	to := tableActionTimeoutSecs(t)
	if to == 0 {
		return fmt.Errorf("invalid actionTimeoutSecs")
	}
	deadline, err := addInt64AndU64Checked(nowUnix, to, "action deadline")
	if err != nil {
		return err
	}
	h.ActionDeadline = deadline
	return nil
}

// applyAction mutates the table state by applying the action for the current ActionOn seat.
func applyAction(t *types.Table, action string, amount uint64, nowUnix int64) ([]sdk.Event, error) {
	h := t.Hand
	if h == nil {
		return nil, fmt.Errorf("no active hand")
	}
	if h.Phase != types.HandPhase_HAND_PHASE_BETTING {
		return nil, fmt.Errorf("hand not in betting phase")
	}

	actorIdx := int(h.ActionOn)
	if actorIdx < 0 || actorIdx >= 9 || t.Seats[actorIdx] == nil {
		return nil, fmt.Errorf("invalid actionOn seat")
	}
	if !h.InHand[actorIdx] || h.Folded[actorIdx] || h.AllIn[actorIdx] {
		return nil, fmt.Errorf("actor not eligible to act")
	}

	switch action {
	case "fold":
		applyFold(h, actorIdx)
	case "check":
		if err := applyCheck(h, actorIdx); err != nil {
			return nil, err
		}
	case "call":
		if err := applyCall(t, actorIdx); err != nil {
			return nil, err
		}
	case "bet":
		if h.BetTo != 0 {
			return nil, fmt.Errorf("cannot bet; use raise")
		}
		if amount == 0 {
			return nil, fmt.Errorf("bet amount must be > 0")
		}
		if err := applyBetTo(t, actorIdx, amount); err != nil {
			return nil, err
		}
	case "raise":
		if h.BetTo == 0 {
			return nil, fmt.Errorf("cannot raise; use bet")
		}
		if amount == 0 {
			return nil, fmt.Errorf("raise amount must be > 0")
		}
		if err := applyBetTo(t, actorIdx, amount); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unknown action")
	}

	events := []sdk.Event{}
	if err := maybeAdvance(t, &events); err != nil {
		return nil, err
	}
	if err := setRevealDeadlineIfAwaiting(t, nowUnix); err != nil {
		return nil, err
	}
	if err := setActionDeadlineIfBetting(t, nowUnix); err != nil {
		return nil, err
	}

	return events, nil
}
