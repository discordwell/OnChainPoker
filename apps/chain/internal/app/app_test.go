package app

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strconv"
	"sync/atomic"
	"testing"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/codec"
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

var testTxNonce uint64

func testEd25519Key(validatorID string) (ed25519.PublicKey, ed25519.PrivateKey) {
	seed := sha256.Sum256([]byte("ocp/test/ed25519/" + validatorID))
	priv := ed25519.NewKeyFromSeed(seed[:])
	pub := priv.Public().(ed25519.PublicKey)
	return pub, priv
}

func txBytesSigned(t *testing.T, typ string, value any, signerID string) []byte {
	t.Helper()
	if signerID == "" {
		t.Fatalf("txBytesSigned: missing signerID")
	}
	_, priv := testEd25519Key(signerID)
	valueBytes := mustMarshal(t, value)
	nonce := fmt.Sprintf("%d", atomic.AddUint64(&testTxNonce, 1))
	msg := txAuthSignBytesV0(typ, valueBytes, nonce, signerID)
	sig := ed25519.Sign(priv, msg)

	env := codec.TxEnvelope{
		Type:   typ,
		Value:  valueBytes,
		Nonce:  nonce,
		Signer: signerID,
		Sig:    sig,
	}
	return mustMarshal(t, env)
}

func registerTestAccount(t *testing.T, a *OCPApp, height int64, account string) {
	t.Helper()
	pub, _ := testEd25519Key(account)
	mustOk(t, a.deliverTx(txBytesSigned(t, "auth/register_account", map[string]any{
		"account": account,
		"pubKey":  []byte(pub),
	}, account), height, 0))
}

const testMinterValidatorID = "faucet"

func ensureTestMinter(t *testing.T, a *OCPApp, height int64) {
	t.Helper()
	if a == nil || a.st == nil {
		t.Fatalf("ensureTestMinter: missing app/state")
	}
	if findValidator(a.st, testMinterValidatorID) != nil {
		return
	}
	pub, _ := testEd25519Key(testMinterValidatorID)
	mustOk(t, a.deliverTx(txBytesSigned(t, "staking/register_validator", map[string]any{
		"validatorId": testMinterValidatorID,
		"pubKey":      []byte(pub),
	}, testMinterValidatorID), height, 0))
}

func mintTestTokens(t *testing.T, a *OCPApp, height int64, to string, amount uint64) {
	t.Helper()
	ensureTestMinter(t, a, height)
	mustOk(t, a.deliverTx(txBytesSigned(t, "bank/mint", map[string]any{
		"to":     to,
		"amount": amount,
	}, testMinterValidatorID), height, 0))
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
	// Tests rely on the insecure DealerStub (public dealing) to exercise the poker
	// state machine without running the full dealer pipeline.
	t.Setenv("OCP_UNSAFE_ALLOW_DEALER_STUB", "1")
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

	mintTestTokens(t, a, height, "alice", 1000)
	mintTestTokens(t, a, height, "bob", 1000)
	registerTestAccount(t, a, height, "alice")
	registerTestAccount(t, a, height, "bob")

	createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":    "alice",
		"smallBlind": 1,
		"bigBlind":   2,
		"minBuyIn":   100,
		"maxBuyIn":   1000,
		"label":      "t",
	}, "alice"), height, 0))
	ev := findEvent(createRes.Events, "TableCreated")
	tableID = parseU64(t, attr(ev, "tableId"))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 100}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 100}, "bob"), height, 0))

	return a, tableID
}

func TestStartHandHeadsUp_PostsBlindsAndDeals(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTable(t)

	startRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}, "alice"), height, 0))
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

	if hand.Phase != state.PhaseBetting || hand.Street != state.StreetPreflop {
		t.Fatalf("expected betting preflop, got phase=%q street=%q", hand.Phase, hand.Street)
	}
	if hand.BetTo != 2 {
		t.Fatalf("expected betTo=2, got %d", hand.BetTo)
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
	if hand.ActionOn != 0 {
		t.Fatalf("expected actionOn=0 (SB) in heads-up preflop, got %d", hand.ActionOn)
	}

	s0 := table.Seats[0]
	s1 := table.Seats[1]
	if s0 == nil || s1 == nil {
		t.Fatalf("expected two seats")
	}
	if s0.Stack != 99 || hand.StreetCommit[0] != 1 || hand.TotalCommit[0] != 1 {
		t.Fatalf("seat0 expected stack=99 commit=1, got stack=%d streetCommit=%d totalCommit=%d", s0.Stack, hand.StreetCommit[0], hand.TotalCommit[0])
	}
	if s1.Stack != 98 || hand.StreetCommit[1] != 2 || hand.TotalCommit[1] != 2 {
		t.Fatalf("seat1 expected stack=98 commit=2, got stack=%d streetCommit=%d totalCommit=%d", s1.Stack, hand.StreetCommit[1], hand.TotalCommit[1])
	}
}

func TestCannotCheckFacingBet(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTable(t)
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}, "alice"), height, 0))

	res := a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "check"}, "alice"), height, 0)
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
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}, "alice"), height, 0))

	// SB calls.
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "call"}, "alice"), height, 0))
	// BB checks, completing preflop -> reveal flop.
	res := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "check"}, "bob"), height, 0))

	if findEvent(res.Events, "StreetRevealed") == nil {
		t.Fatalf("expected StreetRevealed event")
	}

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("expected active hand")
	}
	h := table.Hand
	if h.Phase != state.PhaseBetting || h.Street != state.StreetFlop {
		t.Fatalf("expected betting flop, got phase=%q street=%q", h.Phase, h.Street)
	}
	if len(h.Board) != 3 {
		t.Fatalf("expected 3 board cards on flop, got %d", len(h.Board))
	}
	if h.BetTo != 0 {
		t.Fatalf("expected betTo reset to 0, got %d", h.BetTo)
	}
	if h.ActionOn != 1 {
		t.Fatalf("expected actionOn=1 (BB) postflop in heads-up, got %d", h.ActionOn)
	}
	for i := 0; i < 2; i++ {
		if h.StreetCommit[i] != 0 || h.LastIntervalActed[i] != -1 {
			t.Fatalf("expected round reset for seat %d, got streetCommit=%d lastActed=%d", i, h.StreetCommit[i], h.LastIntervalActed[i])
		}
	}
}

func TestFoldAwardsPotAndEndsHand(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTable(t)
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}, "alice"), height, 0))

	res := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "fold"}, "alice"), height, 0))
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

	mintTestTokens(t, a, height, "alice", 1000)
	mintTestTokens(t, a, height, "bob", 1000)
	mintTestTokens(t, a, height, "charlie", 1000)
	registerTestAccount(t, a, height, "alice")
	registerTestAccount(t, a, height, "bob")
	registerTestAccount(t, a, height, "charlie")

	createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":    "alice",
		"smallBlind": 1,
		"bigBlind":   2,
		"minBuyIn":   100,
		"maxBuyIn":   1000,
	}, "alice"), height, 0))
	tableID := parseU64(t, attr(findEvent(createRes.Events, "TableCreated"), "tableId"))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 100}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 100}, "bob"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "charlie", "tableId": tableID, "seat": 2, "buyIn": 100}, "charlie"), height, 0))

	// Simulate alice being busted but still seated.
	a.st.Tables[tableID].Seats[0].Stack = 0

	startRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "bob", "tableId": tableID}, "bob"), height, 0))

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("expected active hand")
	}
	if table.Hand.InHand[0] {
		t.Fatalf("expected zero-stack seat to be excluded from hand.inHand")
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

func TestSidePots_ShowdownAwardsMainAndSidePotCorrectly(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	// Three players, one short-stacked to force a main+side pot.
	mintTestTokens(t, a, height, "alice", 1000)
	mintTestTokens(t, a, height, "bob", 1000)
	mintTestTokens(t, a, height, "charlie", 1000)
	registerTestAccount(t, a, height, "alice")
	registerTestAccount(t, a, height, "bob")
	registerTestAccount(t, a, height, "charlie")

	createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":    "alice",
		"smallBlind": 1,
		"bigBlind":   2,
		"minBuyIn":   1,
		"maxBuyIn":   1000,
	}, "alice"), height, 0))
	tableID := parseU64(t, attr(findEvent(createRes.Events, "TableCreated"), "tableId"))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 10}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 100}, "bob"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "charlie", "tableId": tableID, "seat": 2, "buyIn": 100}, "charlie"), height, 0))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}, "alice"), height, 0))

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("expected active hand")
	}
	h := table.Hand

	// First hand: button is lowest-index funded seat (0). With 3 players: SB=1, BB=2, action starts at 0.
	if h.ButtonSeat != 0 || h.SmallBlindSeat != 1 || h.BigBlindSeat != 2 || h.ActionOn != 0 {
		t.Fatalf("unexpected positions: button=%d sb=%d bb=%d actionOn=%d", h.ButtonSeat, h.SmallBlindSeat, h.BigBlindSeat, h.ActionOn)
	}
	if h.DeckCursor != 6 {
		t.Fatalf("expected deckCursor=6 after dealing 6 cards, got %d", h.DeckCursor)
	}

	// Override the dealer stub deck + hole cards to make a deterministic flush showdown:
	// Board: 2h 5h 8h Jh 3c (four hearts), so the heart kicker decides.
	// Alice: Ah (wins main), Bob: Kh (wins side vs Charlie: Qh).
	prefix := []state.Card{
		// Hole cards (dealing order: SB, BB, BTN, SB, BB, BTN).
		state.Card(37), // Kh -> bob
		state.Card(36), // Qh -> charlie
		state.Card(38), // Ah -> alice
		state.Card(5),  // 7c -> bob
		state.Card(44), // 7s -> charlie
		state.Card(18), // 7d -> alice
		// Board runout (no burn in v0 dealer stub).
		state.Card(26), // 2h
		state.Card(29), // 5h
		state.Card(32), // 8h
		state.Card(35), // Jh
		state.Card(1),  // 3c
	}
	seen := make([]bool, 52)
	deck := make([]state.Card, 0, 52)
	for _, c := range prefix {
		if seen[int(c)] {
			t.Fatalf("duplicate in prefix: %d", c)
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
	h.Deck = deck
	h.DeckCursor = 6 // after dealing 6 hole cards
	table.Seats[0].Hole = [2]state.Card{state.Card(38), state.Card(18)}
	table.Seats[1].Hole = [2]state.Card{state.Card(37), state.Card(5)}
	table.Seats[2].Hole = [2]state.Card{state.Card(36), state.Card(44)}

	// Preflop: Alice (all-in 10), Bob calls to 10, Charlie raises to 50, Bob calls to 50.
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "raise", "amount": 10}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "call"}, "bob"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "charlie", "tableId": tableID, "action": "raise", "amount": 50}, "charlie"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "call"}, "bob"), height, 0))

	// Check down to showdown.
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "check"}, "bob"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "charlie", "tableId": tableID, "action": "check"}, "charlie"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "check"}, "bob"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "charlie", "tableId": tableID, "action": "check"}, "charlie"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "check"}, "bob"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "charlie", "tableId": tableID, "action": "check"}, "charlie"), height, 0))

	// Hand should be complete and cleared.
	if table.Hand != nil {
		t.Fatalf("expected hand to be cleared after showdown")
	}

	// Pots: main=30 to alice; side=80 to bob.
	if table.Seats[0].Stack != 30 {
		t.Fatalf("alice stack mismatch: got %d want 30", table.Seats[0].Stack)
	}
	if table.Seats[1].Stack != 130 {
		t.Fatalf("bob stack mismatch: got %d want 130", table.Seats[1].Stack)
	}
	if table.Seats[2].Stack != 50 {
		t.Fatalf("charlie stack mismatch: got %d want 50", table.Seats[2].Stack)
	}
}
