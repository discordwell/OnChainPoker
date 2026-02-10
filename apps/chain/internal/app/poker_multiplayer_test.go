package app

import (
	"testing"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/state"
)

func buildDeckFromPrefix(t *testing.T, prefix []state.Card) []state.Card {
	t.Helper()

	seen := make([]bool, 52)
	deck := make([]state.Card, 0, 52)
	for _, c := range prefix {
		if c > 51 {
			t.Fatalf("prefix card out of range: %d", c)
		}
		if seen[int(c)] {
			t.Fatalf("duplicate card in prefix: %d", c)
		}
		seen[int(c)] = true
		deck = append(deck, c)
	}
	for i := 0; i < 52; i++ {
		if seen[i] {
			continue
		}
		deck = append(deck, state.Card(i))
	}
	if len(deck) != 52 {
		t.Fatalf("bad deck length: got %d want 52", len(deck))
	}
	return deck
}

func potAwardEventsByIndex(t *testing.T, events []abci.Event) map[uint64]abci.Event {
	t.Helper()
	out := map[uint64]abci.Event{}
	for i := range events {
		if events[i].Type != "PotAwarded" {
			continue
		}
		idx := parseU64(t, attr(&events[i], "potIndex"))
		out[idx] = events[i]
	}
	return out
}

func TestMultiwayAllIn_ThreeSidePots_AwardedCorrectly(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	// Four players, three all-in tiers: 10 / 20 / 50 / 50.
	mintTestTokens(t, a, height, "alice", 1000)
	mintTestTokens(t, a, height, "bob", 1000)
	mintTestTokens(t, a, height, "charlie", 1000)
	mintTestTokens(t, a, height, "dave", 1000)

	registerTestAccount(t, a, height, "alice")
	registerTestAccount(t, a, height, "bob")
	registerTestAccount(t, a, height, "charlie")
	registerTestAccount(t, a, height, "dave")

	createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":    "alice",
		"smallBlind": 1,
		"bigBlind":   2,
		"minBuyIn":   1,
		"maxBuyIn":   1000,
	}, "alice"), height, 0))
	tableID := parseU64(t, attr(findEvent(createRes.Events, "TableCreated"), "tableId"))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 10}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 20}, "bob"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "charlie", "tableId": tableID, "seat": 2, "buyIn": 50}, "charlie"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "dave", "tableId": tableID, "seat": 3, "buyIn": 50}, "dave"), height, 0))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}, "alice"), height, 0))
	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("expected active hand")
	}
	h := table.Hand

	// First hand: button=0, SB=1, BB=2, action starts at 3.
	if h.ButtonSeat != 0 || h.SmallBlindSeat != 1 || h.BigBlindSeat != 2 || h.ActionOn != 3 {
		t.Fatalf("unexpected positions: button=%d sb=%d bb=%d actionOn=%d", h.ButtonSeat, h.SmallBlindSeat, h.BigBlindSeat, h.ActionOn)
	}
	if h.DeckCursor != 8 {
		t.Fatalf("expected deckCursor=8 after dealing 8 cards, got %d", h.DeckCursor)
	}

	// Force a deterministic showdown ordering by setting the hole cards + runout:
	// - Alice: As Ad
	// - Bob:   Ks Kd
	// - Charlie: Qs Qd
	// - Dave:  Js Jd
	// Board: 2c 3d 4h 8s 9c (no straight/flush; pocket pairs decide).
	//
	// Dealing order is SB, BB, UTG, BTN, then repeat.
	prefix := []state.Card{
		// Hole cards round 1.
		state.Card(50), // Ks -> bob (SB seat1)
		state.Card(49), // Qs -> charlie (BB seat2)
		state.Card(48), // Js -> dave (UTG seat3)
		state.Card(51), // As -> alice (BTN seat0)
		// Hole cards round 2.
		state.Card(24), // Kd -> bob
		state.Card(23), // Qd -> charlie
		state.Card(22), // Jd -> dave
		state.Card(25), // Ad -> alice
		// Board runout.
		state.Card(0),  // 2c
		state.Card(14), // 3d
		state.Card(28), // 4h
		state.Card(45), // 8s
		state.Card(7),  // 9c
	}
	h.Deck = buildDeckFromPrefix(t, prefix)
	h.DeckCursor = 8

	table.Seats[0].Hole = [2]state.Card{state.Card(51), state.Card(25)}
	table.Seats[1].Hole = [2]state.Card{state.Card(50), state.Card(24)}
	table.Seats[2].Hole = [2]state.Card{state.Card(49), state.Card(23)}
	table.Seats[3].Hole = [2]state.Card{state.Card(48), state.Card(22)}

	// Preflop:
	// - Dave jams 50.
	// - Alice calls all-in 10.
	// - Bob calls all-in 20 (including his SB).
	// - Charlie calls all-in 50 (including his BB), completing the action and triggering runout+settlement.
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "dave", "tableId": tableID, "action": "raise", "amount": 50}, "dave"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "call"}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "call"}, "bob"), height, 0))
	final := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "charlie", "tableId": tableID, "action": "call"}, "charlie"), height, 0))

	if findEvent(final.Events, "HandCompleted") == nil {
		t.Fatalf("expected HandCompleted on final action")
	}
	if table.Hand != nil {
		t.Fatalf("expected hand to be cleared after settlement")
	}

	// Pots:
	// - main: 10*4=40 (winner: Alice)
	// - side1: (20-10)*3=30 (winner: Bob)
	// - side2: (50-20)*2=60 (winner: Charlie)
	if table.Seats[0].Stack != 40 {
		t.Fatalf("alice stack mismatch: got %d want 40", table.Seats[0].Stack)
	}
	if table.Seats[1].Stack != 30 {
		t.Fatalf("bob stack mismatch: got %d want 30", table.Seats[1].Stack)
	}
	if table.Seats[2].Stack != 60 {
		t.Fatalf("charlie stack mismatch: got %d want 60", table.Seats[2].Stack)
	}
	if table.Seats[3].Stack != 0 {
		t.Fatalf("dave stack mismatch: got %d want 0", table.Seats[3].Stack)
	}

	// Verify pot-tier amounts + eligible/winner seats via events.
	pots := potAwardEventsByIndex(t, final.Events)
	if len(pots) != 3 {
		// Print types for quick debugging.
		types := map[string]int{}
		for _, ev := range final.Events {
			types[ev.Type]++
		}
		t.Fatalf("expected 3 PotAwarded events, got %d (events=%v)", len(pots), types)
	}

	type expPot struct {
		amount   string
		eligible string
		winners  string
	}
	exp := map[uint64]expPot{
		0: {amount: "40", eligible: "0,1,2,3", winners: "0"},
		1: {amount: "30", eligible: "1,2,3", winners: "1"},
		2: {amount: "60", eligible: "2,3", winners: "2"},
	}
	for idx, want := range exp {
		ev, ok := pots[idx]
		if !ok {
			t.Fatalf("missing PotAwarded for potIndex=%d", idx)
		}
		if got := attr(&ev, "amount"); got != want.amount {
			t.Fatalf("pot %d amount mismatch: got %q want %q", idx, got, want.amount)
		}
		if got := attr(&ev, "eligibleSeats"); got != want.eligible {
			t.Fatalf("pot %d eligibleSeats mismatch: got %q want %q", idx, got, want.eligible)
		}
		if got := attr(&ev, "winners"); got != want.winners {
			t.Fatalf("pot %d winners mismatch: got %q want %q", idx, got, want.winners)
		}
	}

	var sum uint64
	for i := 0; i < 4; i++ {
		sum += table.Seats[i].Stack
	}
	if sum != 130 {
		t.Fatalf("chip conservation failed: sum=%d want=130", sum)
	}
}
