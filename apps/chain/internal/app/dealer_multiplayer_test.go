package app

import (
	"encoding/base64"
	"sort"
	"testing"

	"onchainpoker/apps/chain/internal/ocpcrypto"
	"onchainpoker/apps/chain/internal/state"
)

func setupThreeHandedTableWithPK(t *testing.T, pkAliceB64, pkBobB64, pkCharlieB64 string) (a *OCPApp, tableID uint64) {
	t.Helper()

	const height = int64(1)
	a = newTestApp(t)

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
		"label":      "t",
	}, "alice"), height, 0))
	ev := findEvent(createRes.Events, "TableCreated")
	tableID = parseU64(t, attr(ev, "tableId"))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 100, "pkPlayer": pkAliceB64}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 100, "pkPlayer": pkBobB64}, "bob"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "charlie", "tableId": tableID, "seat": 2, "buyIn": 100, "pkPlayer": pkCharlieB64}, "charlie"), height, 0))

	return a, tableID
}

func TestDealer_ShowdownRevealOrdering_3Handed_FoldSkipsSeat(t *testing.T) {
	height := int64(1)

	// Player keys (toy).
	pkAlice := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(999))
	pkBob := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1001))
	pkCharlie := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1003))
	a, tableID := setupThreeHandedTableWithPK(t,
		base64.StdEncoding.EncodeToString(pkAlice.Bytes()),
		base64.StdEncoding.EncodeToString(pkBob.Bytes()),
		base64.StdEncoding.EncodeToString(pkCharlie.Bytes()),
	)

	epochID, members, height := setupDKGEpoch(t, a, height, []string{"v1"}, 1)
	member := members[0]

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}, "alice"), height, 0))
	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("expected active hand")
	}
	handID := table.Hand.HandID

	submitShuffleOnce(t, a, height, tableID, handID, "v1")
	mustOk(t, a.deliverTx(txBytes(t, "dealer/finalize_deck", map[string]any{
		"tableId": tableID,
		"handId":  handID,
	}), height, 0))

	// Provide encrypted shares for 6 hole cards (3 seats x 2 cards, threshold 1).
	dh := table.Hand.Dealer
	pkBySeat := map[int]ocpcrypto.Point{
		0: pkAlice,
		1: pkBob,
		2: pkCharlie,
	}
	for seat := 0; seat < 3; seat++ {
		pkPlayer := pkBySeat[seat]
		for c := 0; c < 2; c++ {
			pos := dh.HolePos[seat*2+c]
			submitEncShare(t, a, height, tableID, handID, epochID, member.id, member.share, pos, pkPlayer,
				uint64(8000+seat*10+c),
				uint64(8100+seat*10+c),
				uint64(8200+seat*10+c),
			)
		}
	}
	if table.Hand.Phase != state.PhaseBetting {
		t.Fatalf("expected betting after hole shares, got %q", table.Hand.Phase)
	}

	// Preflop: BTN calls, SB folds, BB checks -> await flop.
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "call"}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "fold"}, "bob"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "charlie", "tableId": tableID, "action": "check"}, "charlie"), height, 0))
	if table.Hand.Phase != state.PhaseAwaitFlop {
		t.Fatalf("expected awaitFlop, got %q", table.Hand.Phase)
	}

	// Flop (3 reveals).
	revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9001)
	revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9002)
	revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9003)
	if table.Hand.Phase != state.PhaseBetting || table.Hand.Street != state.StreetFlop {
		t.Fatalf("expected betting flop after 3 reveals, got phase=%q street=%q", table.Hand.Phase, table.Hand.Street)
	}

	// Flop: check/check -> await turn (action starts left of button, skipping the folded SB).
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "charlie", "tableId": tableID, "action": "check"}, "charlie"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "check"}, "alice"), height, 0))
	if table.Hand.Phase != state.PhaseAwaitTurn {
		t.Fatalf("expected awaitTurn, got %q", table.Hand.Phase)
	}

	// Turn (1 reveal), then check/check -> await river.
	revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9010)
	if table.Hand.Phase != state.PhaseBetting || table.Hand.Street != state.StreetTurn {
		t.Fatalf("expected betting turn, got phase=%q street=%q", table.Hand.Phase, table.Hand.Street)
	}
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "charlie", "tableId": tableID, "action": "check"}, "charlie"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "check"}, "alice"), height, 0))
	if table.Hand.Phase != state.PhaseAwaitRiver {
		t.Fatalf("expected awaitRiver, got %q", table.Hand.Phase)
	}

	// River (1 reveal), then check/check -> await showdown.
	revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9020)
	if table.Hand.Phase != state.PhaseBetting || table.Hand.Street != state.StreetRiver {
		t.Fatalf("expected betting river, got phase=%q street=%q", table.Hand.Phase, table.Hand.Street)
	}
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "charlie", "tableId": tableID, "action": "check"}, "charlie"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "check"}, "alice"), height, 0))
	if table.Hand.Phase != state.PhaseAwaitShowdown {
		t.Fatalf("expected awaitShowdown, got %q", table.Hand.Phase)
	}

	// Reveal ordering at showdown: reveal all eligible hole-card positions (non-folded seats only), in
	// increasing deck-position order.
	if table.Hand == nil || table.Hand.Dealer == nil {
		t.Fatalf("missing dealer hand")
	}
	dh = table.Hand.Dealer

	posToSeat := map[uint8]int{}
	eligiblePos := make([]uint8, 0, 18)
	for seat := 0; seat < 9; seat++ {
		if !table.Hand.InHand[seat] || table.Hand.Folded[seat] {
			continue
		}
		for c := 0; c < 2; c++ {
			pos := dh.HolePos[seat*2+c]
			if pos == 255 {
				t.Fatalf("holePos unset for seat %d", seat)
			}
			posToSeat[pos] = seat
			eligiblePos = append(eligiblePos, pos)
		}
	}
	sort.Slice(eligiblePos, func(i, j int) bool { return eligiblePos[i] < eligiblePos[j] })
	if len(eligiblePos) != 4 {
		t.Fatalf("expected 4 eligible hole positions (2 players), got %d: %v", len(eligiblePos), eligiblePos)
	}

	for i, wantPos := range eligiblePos {
		gotPos, ok, err := dealerExpectedRevealPos(table)
		if err != nil {
			t.Fatalf("dealerExpectedRevealPos: %v", err)
		}
		if !ok {
			t.Fatalf("expected a revealable pos at i=%d", i)
		}
		if gotPos != wantPos {
			t.Fatalf("unexpected showdown reveal pos at i=%d: got %d want %d (eligible=%v)", i, gotPos, wantPos, eligiblePos)
		}

		res := revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9030+uint64(i))
		holeEv := findEvent(res.Events, "HoleCardRevealed")
		if holeEv == nil {
			t.Fatalf("expected HoleCardRevealed event at i=%d", i)
		}
		gotSeat := int(parseU64(t, attr(holeEv, "seat")))
		if wantSeat := posToSeat[wantPos]; gotSeat != wantSeat {
			t.Fatalf("HoleCardRevealed seat mismatch at i=%d pos=%d: got %d want %d", i, wantPos, gotSeat, wantSeat)
		}

		if i == len(eligiblePos)-1 {
			if findEvent(res.Events, "HandCompleted") == nil {
				t.Fatalf("expected HandCompleted after last hole reveal")
			}
			// Verify side-pot computation merges folded contributions into a single eligible pot.
			pots := potAwardEventsByIndex(t, res.Events)
			if len(pots) != 1 {
				t.Fatalf("expected 1 PotAwarded event at showdown, got %d", len(pots))
			}
			ev, ok := pots[0]
			if !ok {
				t.Fatalf("expected potIndex=0 to exist")
			}
			if got := attr(&ev, "amount"); got != "5" {
				t.Fatalf("pot amount mismatch: got %q want %q", got, "5")
			}
			if got := attr(&ev, "eligibleSeats"); got != "0,2" {
				t.Fatalf("eligibleSeats mismatch: got %q want %q", got, "0,2")
			}
		}
	}

	if table.Hand != nil {
		t.Fatalf("expected hand to be cleared after settlement")
	}
}
