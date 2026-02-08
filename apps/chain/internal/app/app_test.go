package app

import (
	"encoding/json"
	"strconv"
	"testing"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/state"
)

func mustMarshal(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

func txBytes(t *testing.T, typ string, value any) []byte {
	t.Helper()
	return mustMarshal(t, map[string]any{
		"type":  typ,
		"value": value,
	})
}

func findEvent(events []abci.Event, typ string) *abci.Event {
	for i := range events {
		if events[i].Type == typ {
			return &events[i]
		}
	}
	return nil
}

func attr(ev *abci.Event, key string) string {
	if ev == nil {
		return ""
	}
	for _, a := range ev.Attributes {
		if a.Key == key {
			return a.Value
		}
	}
	return ""
}

func parseU64(t *testing.T, s string) uint64 {
	t.Helper()
	n, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		t.Fatalf("parse uint64 %q: %v", s, err)
	}
	return n
}

func newTestApp(t *testing.T) *OCPApp {
	t.Helper()
	a, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return a
}

func mustOk(t *testing.T, res *abci.ExecTxResult) *abci.ExecTxResult {
	t.Helper()
	if res.Code != 0 {
		t.Fatalf("expected ok, got code=%d log=%q", res.Code, res.Log)
	}
	return res
}

func setupHeadsUpTable(t *testing.T) (a *OCPApp, tableID uint64) {
	t.Helper()

	const height = int64(1)
	a = newTestApp(t)

	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "alice", "amount": 1000}), height))
	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "bob", "amount": 1000}), height))

	createRes := mustOk(t, a.deliverTx(txBytes(t, "poker/create_table", map[string]any{
		"creator":  "alice",
		"smallBlind": 1,
		"bigBlind":   2,
		"minBuyIn":   100,
		"maxBuyIn":   1000,
		"label":      "t",
	}), height))
	ev := findEvent(createRes.Events, "TableCreated")
	tableID = parseU64(t, attr(ev, "tableId"))

	mustOk(t, a.deliverTx(txBytes(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 100}), height))
	mustOk(t, a.deliverTx(txBytes(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 100}), height))

	return a, tableID
}

func TestStartHandHeadsUp_PostsBlindsAndDeals(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTable(t)

	startRes := mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))
	if findEvent(startRes.Events, "HandStarted") == nil {
		t.Fatalf("expected HandStarted event")
	}

	holeEvents := 0
	for _, ev := range startRes.Events {
		if ev.Type == "HoleCardAssigned" {
			holeEvents++
		}
	}
	if holeEvents != 2 {
		t.Fatalf("expected 2 HoleCardAssigned events, got %d", holeEvents)
	}

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("expected active hand")
	}
	hand := table.Hand

	if hand.Phase != state.PhasePreflop {
		t.Fatalf("expected preflop phase, got %q", hand.Phase)
	}
	if hand.Pot != 3 {
		t.Fatalf("expected pot=3, got %d", hand.Pot)
	}
	if hand.CurrentBet != 2 {
		t.Fatalf("expected currentBet=2, got %d", hand.CurrentBet)
	}
	if hand.DeckCursor != 4 {
		t.Fatalf("expected deckCursor=4 after dealing 4 cards, got %d", hand.DeckCursor)
	}
	if len(hand.Board) != 0 {
		t.Fatalf("expected empty board")
	}

	// First hand: button is the lowest-index funded seat (0), and heads-up SB=button.
	if table.ButtonSeat != 0 {
		t.Fatalf("expected buttonSeat=0, got %d", table.ButtonSeat)
	}
	if hand.ActingSeat != 0 {
		t.Fatalf("expected actingSeat=0 (SB) in heads-up preflop, got %d", hand.ActingSeat)
	}

	s0 := table.Seats[0]
	s1 := table.Seats[1]
	if s0 == nil || s1 == nil {
		t.Fatalf("expected two seats")
	}
	if s0.Stack != 99 || s0.BetThisRound != 1 {
		t.Fatalf("seat0 expected stack=99 bet=1, got stack=%d bet=%d", s0.Stack, s0.BetThisRound)
	}
	if s1.Stack != 98 || s1.BetThisRound != 2 {
		t.Fatalf("seat1 expected stack=98 bet=2, got stack=%d bet=%d", s1.Stack, s1.BetThisRound)
	}
}

func TestCannotCheckFacingBet(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTable(t)
	mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))

	res := a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "check"}), height)
	if res.Code == 0 {
		t.Fatalf("expected error")
	}
	if res.Log == "" {
		t.Fatalf("expected error log")
	}
}

func TestCallThenCheck_AdvancesToFlopAndResetsRound(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTable(t)
	mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))

	// SB calls.
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "call"}), height))
	// BB checks, completing preflop -> reveal flop.
	res := mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "check"}), height))

	if findEvent(res.Events, "StreetRevealed") == nil {
		t.Fatalf("expected StreetRevealed event")
	}

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("expected active hand")
	}
	h := table.Hand
	if h.Phase != state.PhaseFlop {
		t.Fatalf("expected flop phase, got %q", h.Phase)
	}
	if len(h.Board) != 3 {
		t.Fatalf("expected 3 board cards on flop, got %d", len(h.Board))
	}
	if h.CurrentBet != 0 {
		t.Fatalf("expected currentBet reset to 0, got %d", h.CurrentBet)
	}
	if h.ActingSeat != 1 {
		t.Fatalf("expected actingSeat=1 (BB) postflop in heads-up, got %d", h.ActingSeat)
	}
	for i := 0; i < 2; i++ {
		s := table.Seats[i]
		if s == nil {
			t.Fatalf("missing seat %d", i)
		}
		if s.BetThisRound != 0 || s.ActedThisRound {
			t.Fatalf("expected round reset for seat %d, got bet=%d acted=%v", i, s.BetThisRound, s.ActedThisRound)
		}
	}
}

func TestFoldAwardsPotAndEndsHand(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTable(t)
	mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))

	res := mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "fold"}), height))
	if findEvent(res.Events, "HandCompleted") == nil {
		t.Fatalf("expected HandCompleted event")
	}

	table := a.st.Tables[tableID]
	if table == nil {
		t.Fatalf("missing table")
	}
	if table.Hand != nil {
		t.Fatalf("expected hand to be cleared after fold win")
	}
	if table.Seats[0].Stack != 99 {
		t.Fatalf("alice stack mismatch: %d", table.Seats[0].Stack)
	}
	if table.Seats[1].Stack != 101 {
		t.Fatalf("bob stack mismatch: %d", table.Seats[1].Stack)
	}
}

func TestStartHand_ExcludesZeroStackSeatsFromHandAndHoleEvents(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "alice", "amount": 1000}), height))
	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "bob", "amount": 1000}), height))
	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "charlie", "amount": 1000}), height))

	createRes := mustOk(t, a.deliverTx(txBytes(t, "poker/create_table", map[string]any{
		"creator":  "alice",
		"smallBlind": 1,
		"bigBlind":   2,
		"minBuyIn":   100,
		"maxBuyIn":   1000,
	}), height))
	tableID := parseU64(t, attr(findEvent(createRes.Events, "TableCreated"), "tableId"))

	mustOk(t, a.deliverTx(txBytes(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 100}), height))
	mustOk(t, a.deliverTx(txBytes(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 100}), height))
	mustOk(t, a.deliverTx(txBytes(t, "poker/sit", map[string]any{"player": "charlie", "tableId": tableID, "seat": 2, "buyIn": 100}), height))

	// Simulate alice being busted but still seated.
	a.st.Tables[tableID].Seats[0].Stack = 0

	startRes := mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "bob", "tableId": tableID}), height))

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("expected active hand")
	}
	if table.Seats[0].InHand {
		t.Fatalf("expected zero-stack seat to be excluded from InHand")
	}

	holes := map[int]bool{}
	for _, ev := range startRes.Events {
		if ev.Type != "HoleCardAssigned" {
			continue
		}
		seatStr := attr(&ev, "seat")
		seatNum, err := strconv.Atoi(seatStr)
		if err != nil {
			t.Fatalf("bad seat attr: %q", seatStr)
		}
		holes[seatNum] = true
	}
	if holes[0] {
		t.Fatalf("expected no hole cards for seat0")
	}
	if !holes[1] || !holes[2] {
		t.Fatalf("expected hole cards for seats 1 and 2; got=%v", holes)
	}
}
