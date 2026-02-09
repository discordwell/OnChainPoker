package app

import (
	"encoding/base64"
	"testing"

	"onchainpoker/apps/chain/internal/ocpcrypto"
	"onchainpoker/apps/chain/internal/state"
)

func setupHeadsUpTableWithPKAndDealerTO(t *testing.T, pkAliceB64, pkBobB64 string, dealerTO uint64, minBuyIn, maxBuyIn, buyInAlice, buyInBob uint64) (a *OCPApp, tableID uint64) {
	t.Helper()

	const height = int64(1)
	a = newTestApp(t)

	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "alice", "amount": 1000}), height))
	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "bob", "amount": 1000}), height))

	createRes := mustOk(t, a.deliverTx(txBytes(t, "poker/create_table", map[string]any{
		"creator":           "alice",
		"smallBlind":        1,
		"bigBlind":          2,
		"minBuyIn":          minBuyIn,
		"maxBuyIn":          maxBuyIn,
		"dealerTimeoutSecs": dealerTO,
		"label":             "t",
	}), height))
	ev := findEvent(createRes.Events, "TableCreated")
	tableID = parseU64(t, attr(ev, "tableId"))

	mustOk(t, a.deliverTx(txBytes(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": buyInAlice, "pkPlayer": pkAliceB64}), height))
	mustOk(t, a.deliverTx(txBytes(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": buyInBob, "pkPlayer": pkBobB64}), height))

	return a, tableID
}

func TestDealerTimeout_Shuffle_SlashesExpectedShufflerAndAllowsNext(t *testing.T) {
	height := int64(1)

	// Player keys (toy).
	pkAlice := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(999))
	pkBob := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1001))
	a, tableID := setupHeadsUpTableWithPKAndDealerTO(
		t,
		base64.StdEncoding.EncodeToString(pkAlice.Bytes()),
		base64.StdEncoding.EncodeToString(pkBob.Bytes()),
		2,    // dealerTimeoutSecs
		100,  // minBuyIn
		1000, // maxBuyIn
		100,  // buyInAlice
		100,  // buyInBob
	)

	_, _, height = setupDKGEpoch(t, a, height, []string{"v1", "v2", "v3"}, 2)

	mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))
	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil || table.Hand.Dealer == nil {
		t.Fatalf("expected dealer hand state")
	}
	handID := table.Hand.HandID
	dh := table.Hand.Dealer
	if dh.ShuffleDeadline == 0 {
		t.Fatalf("expected shuffle deadline set")
	}

	// Trigger timeout at/after the shuffle deadline; v1 is the expected shuffler for round 1.
	timeoutH := dh.ShuffleDeadline
	res := mustOk(t, a.deliverTx(txBytes(t, "dealer/timeout", map[string]any{
		"tableId": tableID,
		"handId":  handID,
	}), timeoutH))
	if findEvent(res.Events, "ValidatorSlashed") == nil {
		t.Fatalf("expected ValidatorSlashed event")
	}
	if a.st.Dealer == nil || a.st.Dealer.Epoch == nil {
		t.Fatalf("expected dealer epoch")
	}
	if len(a.st.Dealer.Epoch.Slashed) != 1 || a.st.Dealer.Epoch.Slashed[0] != "v1" {
		t.Fatalf("expected v1 slashed, got %v", a.st.Dealer.Epoch.Slashed)
	}
	v1 := findValidator(a.st, "v1")
	if v1 == nil {
		t.Fatalf("expected v1 validator record")
	}
	if v1.Status != state.ValidatorJailed {
		t.Fatalf("expected v1 jailed after timeout slash")
	}
	if v1.Bond != 90 {
		t.Fatalf("expected v1 bond slashed to 90 (10%%), got %d", v1.Bond)
	}
	if got := a.st.Balance(treasuryAccount); got != 10 {
		t.Fatalf("expected treasury balance 10 after slash, got %d", got)
	}

	// Now v2 should be the expected shuffler for round 1.
	submitShuffleOnce(t, a, timeoutH, tableID, handID, "v2")
	if table.Hand.Dealer.ShuffleStep != 1 {
		t.Fatalf("expected shuffleStep=1, got %d", table.Hand.Dealer.ShuffleStep)
	}
}

func TestDealerTimeout_Reveal_SlashesMissingAndFinalizesReveal(t *testing.T) {
	height := int64(1)

	// Player keys (toy).
	pkAlice := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(999))
	pkBob := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1001))

	// Force an all-in preflop via asymmetric buy-ins so we enter PhaseAwaitFlop immediately after hole shares are ready.
	a, tableID := setupHeadsUpTableWithPKAndDealerTO(
		t,
		base64.StdEncoding.EncodeToString(pkAlice.Bytes()),
		base64.StdEncoding.EncodeToString(pkBob.Bytes()),
		2, // dealerTimeoutSecs
		1, // minBuyIn
		2, // maxBuyIn
		1, // buyInAlice (SB all-in)
		2, // buyInBob (BB all-in)
	)

	epochID, members, height := setupDKGEpoch(t, a, height, []string{"v1", "v2", "v3"}, 2)

	mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))
	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil || table.Hand.Dealer == nil {
		t.Fatalf("expected dealer hand state")
	}
	handID := table.Hand.HandID
	dh := table.Hand.Dealer

	submitAllShuffles(t, a, height, tableID, handID)
	mustOk(t, a.deliverTx(txBytes(t, "dealer/finalize_deck", map[string]any{
		"tableId": tableID,
		"handId":  handID,
	}), height))

	// Provide encrypted shares for hole cards (2 seats x 2 cards x threshold(2) = 8 enc shares).
	for seat := 0; seat < 2; seat++ {
		pkPlayer := pkAlice
		if seat == 1 {
			pkPlayer = pkBob
		}
		for c := 0; c < 2; c++ {
			pos := dh.HolePos[seat*2+c]
			for i := 0; i < 2; i++ {
				submitEncShare(t, a, height, tableID, handID, epochID, members[i].id, members[i].share, pos, pkPlayer,
					uint64(5000+seat*10+c*2+i),
					uint64(6000+seat*10+c*2+i),
					uint64(7000+seat*10+c*2+i),
				)
			}
		}
	}

	if table.Hand.Phase != state.PhaseAwaitFlop {
		t.Fatalf("expected awaitFlop, got phase=%q", table.Hand.Phase)
	}
	if dh.RevealDeadline == 0 || dh.RevealPos == 255 {
		t.Fatalf("expected reveal deadline set")
	}

	// Submit threshold pub shares for the first reveal pos before the deadline.
	pos := dh.RevealPos
	submitPubShare(t, a, height+1, tableID, handID, epochID, members[0].id, members[0].share, pos, 123)
	submitPubShare(t, a, height+1, tableID, handID, epochID, members[1].id, members[1].share, pos, 456)

	// Trigger timeout at/after deadline. v3 should be slashed and the reveal should be finalized.
	timeoutH := dh.RevealDeadline
	res := mustOk(t, a.deliverTx(txBytes(t, "dealer/timeout", map[string]any{
		"tableId": tableID,
		"handId":  handID,
	}), timeoutH))
	if findEvent(res.Events, "ValidatorSlashed") == nil {
		t.Fatalf("expected ValidatorSlashed event")
	}
	if findEvent(res.Events, "RevealFinalized") == nil {
		t.Fatalf("expected RevealFinalized event")
	}
	if len(table.Hand.Board) != 1 {
		t.Fatalf("expected 1 board card after timeout-finalized reveal, got %d", len(table.Hand.Board))
	}
	if len(a.st.Dealer.Epoch.Slashed) == 0 {
		t.Fatalf("expected some slashed validators")
	}
}

func TestDealerTimeout_HoleShares_AbortsAndRefunds(t *testing.T) {
	height := int64(1)

	// Player keys (toy).
	pkAlice := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(999))
	pkBob := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1001))
	a, tableID := setupHeadsUpTableWithPKAndDealerTO(
		t,
		base64.StdEncoding.EncodeToString(pkAlice.Bytes()),
		base64.StdEncoding.EncodeToString(pkBob.Bytes()),
		2,    // dealerTimeoutSecs
		100,  // minBuyIn
		1000, // maxBuyIn
		100,  // buyInAlice
		100,  // buyInBob
	)

	epochID, members, height := setupDKGEpoch(t, a, height, []string{"v1", "v2", "v3"}, 2)

	mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))
	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil || table.Hand.Dealer == nil {
		t.Fatalf("expected dealer hand state")
	}
	handID := table.Hand.HandID
	dh := table.Hand.Dealer

	submitAllShuffles(t, a, height, tableID, handID)
	mustOk(t, a.deliverTx(txBytes(t, "dealer/finalize_deck", map[string]any{
		"tableId": tableID,
		"handId":  handID,
	}), height))

	// Only one validator submits hole enc shares; should be insufficient for threshold(2).
	for seat := 0; seat < 2; seat++ {
		pkPlayer := pkAlice
		if seat == 1 {
			pkPlayer = pkBob
		}
		for c := 0; c < 2; c++ {
			pos := dh.HolePos[seat*2+c]
			submitEncShare(t, a, height, tableID, handID, epochID, members[0].id, members[0].share, pos, pkPlayer,
				uint64(8000+seat*10+c),
				uint64(9000+seat*10+c),
				uint64(10000+seat*10+c),
			)
		}
	}
	if table.Hand.Phase != state.PhaseShuffle {
		t.Fatalf("expected still in shuffle phase")
	}

	// Timeout at/after hole shares deadline should abort and refund blinds/commits.
	timeoutH := dh.HoleSharesDeadline
	res := mustOk(t, a.deliverTx(txBytes(t, "dealer/timeout", map[string]any{
		"tableId": tableID,
		"handId":  handID,
	}), timeoutH))
	if findEvent(res.Events, "HandAborted") == nil {
		t.Fatalf("expected HandAborted event")
	}
	if table.Hand != nil {
		t.Fatalf("expected hand cleared after abort")
	}

	// Refund semantics: return all TotalCommit to stacks.
	if table.Seats[0] == nil || table.Seats[1] == nil {
		t.Fatalf("expected two seats")
	}
	if table.Seats[0].Stack != 100 || table.Seats[1].Stack != 100 {
		t.Fatalf("expected stacks refunded to 100/100, got %d/%d", table.Seats[0].Stack, table.Seats[1].Stack)
	}
}
