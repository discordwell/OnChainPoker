package app

import (
	"encoding/base64"
	"testing"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/ocpcrypto"
	"onchainpoker/apps/chain/internal/ocpshuffle"
	"onchainpoker/apps/chain/internal/state"
)

func setupHeadsUpTableWithPK(t *testing.T, pkAliceB64, pkBobB64 string) (a *OCPApp, tableID uint64) {
	t.Helper()

	const height = int64(1)
	a = newTestApp(t)

	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "alice", "amount": 1000}), height))
	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "bob", "amount": 1000}), height))

	createRes := mustOk(t, a.deliverTx(txBytes(t, "poker/create_table", map[string]any{
		"creator":   "alice",
		"smallBlind": 1,
		"bigBlind":   2,
		"minBuyIn":   100,
		"maxBuyIn":   1000,
		"label":      "t",
	}), height))
	ev := findEvent(createRes.Events, "TableCreated")
	tableID = parseU64(t, attr(ev, "tableId"))

	mustOk(t, a.deliverTx(txBytes(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 100, "pkPlayer": pkAliceB64}), height))
	mustOk(t, a.deliverTx(txBytes(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 100, "pkPlayer": pkBobB64}), height))

	return a, tableID
}

type testMember struct {
	id    string
	index uint32
	share ocpcrypto.Scalar
}

func submitPubShare(t *testing.T, a *OCPApp, height int64, tableID, handID, epochID uint64, validatorID string, xShare ocpcrypto.Scalar, pos uint8, w uint64) {
	t.Helper()

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil || table.Hand.Dealer == nil {
		t.Fatalf("missing dealer hand")
	}
	dh := table.Hand.Dealer

	k, err := deriveHandScalar(epochID, tableID, handID)
	if err != nil {
		t.Fatalf("derive hand scalar: %v", err)
	}

	xHand := ocpcrypto.ScalarMul(xShare, k)
	yHand := ocpcrypto.MulBase(xHand)
	c1, err := ocpcrypto.PointFromBytesCanonical(dh.Deck[pos].C1)
	if err != nil {
		t.Fatalf("deck c1: %v", err)
	}
	share := ocpcrypto.MulPoint(c1, xHand)

	cp, err := ocpcrypto.ChaumPedersenProve(yHand, c1, share, xHand, ocpcrypto.ScalarFromUint64(w))
	if err != nil {
		t.Fatalf("cp prove: %v", err)
	}
	proofBytes := ocpcrypto.EncodeChaumPedersenProof(cp)

	mustOk(t, a.deliverTx(txBytes(t, "dealer/submit_pub_share", map[string]any{
		"tableId":     tableID,
		"handId":      handID,
		"pos":         pos,
		"validatorId": validatorID,
		"pubShare":    share.Bytes(),
		"proofShare":  proofBytes,
	}), height))
}

func submitEncShare(t *testing.T, a *OCPApp, height int64, tableID, handID, epochID uint64, validatorID string, xShare ocpcrypto.Scalar, pos uint8, pkPlayer ocpcrypto.Point, rSeed, wxSeed, wrSeed uint64) {
	t.Helper()

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil || table.Hand.Dealer == nil {
		t.Fatalf("missing dealer hand")
	}
	dh := table.Hand.Dealer

	k, err := deriveHandScalar(epochID, tableID, handID)
	if err != nil {
		t.Fatalf("derive hand scalar: %v", err)
	}

	xHand := ocpcrypto.ScalarMul(xShare, k)
	YHand := ocpcrypto.MulBase(xHand)
	c1Cipher, err := ocpcrypto.PointFromBytesCanonical(dh.Deck[pos].C1)
	if err != nil {
		t.Fatalf("cipher c1: %v", err)
	}
	share := ocpcrypto.MulPoint(c1Cipher, xHand)

	r := ocpcrypto.ScalarFromUint64(rSeed)
	U := ocpcrypto.MulBase(r)
	V := ocpcrypto.PointAdd(share, ocpcrypto.MulPoint(pkPlayer, r))

	proof, err := ocpcrypto.EncShareProve(
		YHand,
		c1Cipher,
		pkPlayer,
		U,
		V,
		xHand,
		r,
		ocpcrypto.ScalarFromUint64(wxSeed),
		ocpcrypto.ScalarFromUint64(wrSeed),
	)
	if err != nil {
		t.Fatalf("EncShareProve: %v", err)
	}

	encShareBytes := append(append([]byte(nil), U.Bytes()...), V.Bytes()...)
	proofBytes := ocpcrypto.EncodeEncShareProof(proof)

	mustOk(t, a.deliverTx(txBytes(t, "dealer/submit_enc_share", map[string]any{
		"tableId":       tableID,
		"handId":        handID,
		"pos":           pos,
		"validatorId":   validatorID,
		"pkPlayer":      pkPlayer.Bytes(),
		"encShare":      encShareBytes,
		"proofEncShare": proofBytes,
	}), height))
}

func revealNextWithMember(t *testing.T, a *OCPApp, height int64, tableID, handID, epochID uint64, member testMember, w uint64) *abci.ExecTxResult {
	t.Helper()
	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("missing table/hand")
	}
	pos, ok, err := dealerExpectedRevealPos(table)
	if err != nil {
		t.Fatalf("expected pos: %v", err)
	}
	if !ok {
		t.Fatalf("hand not awaiting a reveal")
	}
	submitPubShare(t, a, height, tableID, handID, epochID, member.id, member.share, pos, w)
	return mustOk(t, a.deliverTx(txBytes(t, "dealer/finalize_reveal", map[string]any{
		"tableId": tableID,
		"handId":  handID,
		"pos":     pos,
	}), height))
}

func TestDealer_RevealNextBoardPos_WithThresholdShares(t *testing.T) {
	const height = int64(1)

	// Player keys (toy).
	pkAlice := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(999))
	pkBob := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1001))
	a, tableID := setupHeadsUpTableWithPK(t, base64.StdEncoding.EncodeToString(pkAlice.Bytes()), base64.StdEncoding.EncodeToString(pkBob.Bytes()))

	// Epoch: 2-of-3 Shamir shares with f(i) = x + a*i.
	epochID := uint64(1)
	x := ocpcrypto.ScalarFromUint64(111)
	a1 := ocpcrypto.ScalarFromUint64(222)
	members := []testMember{}
	for i := uint32(1); i <= 3; i++ {
		xi := ocpcrypto.ScalarAdd(x, ocpcrypto.ScalarMul(a1, ocpcrypto.ScalarFromUint64(uint64(i))))
		members = append(members, testMember{id: "v" + string(rune('0'+i)), index: i, share: xi})
	}

	beginEpoch := map[string]any{
		"epochId":   epochID,
		"threshold": 2,
		"pkEpoch":   ocpcrypto.MulBase(x).Bytes(),
		"members": []map[string]any{
			{"validatorId": "v1", "index": uint32(1), "pubShare": ocpcrypto.MulBase(members[0].share).Bytes()},
			{"validatorId": "v2", "index": uint32(2), "pubShare": ocpcrypto.MulBase(members[1].share).Bytes()},
			{"validatorId": "v3", "index": uint32(3), "pubShare": ocpcrypto.MulBase(members[2].share).Bytes()},
		},
	}
	mustOk(t, a.deliverTx(txBytes(t, "dealer/begin_epoch", beginEpoch), height))

	// Start a dealer-mode hand (starts in shuffle phase and initializes the encrypted deck).
	mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil || table.Hand.Dealer == nil {
		t.Fatalf("expected dealer hand state")
	}
	handID := table.Hand.HandID
	dh := table.Hand.Dealer
	if int(dh.DeckSize) != 52 || len(dh.Deck) != 52 {
		t.Fatalf("deck size mismatch: deckSize=%d len=%d", dh.DeckSize, len(dh.Deck))
	}

	// Finalize the deck (assign hole positions + community cursor).
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

	if table.Hand.Phase != state.PhaseBetting {
		t.Fatalf("expected betting phase after hole shares, got %q", table.Hand.Phase)
	}

	// Complete preflop quickly: SB calls, BB checks.
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "call"}), height))
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "check"}), height))
	if table.Hand.Phase != state.PhaseAwaitFlop {
		t.Fatalf("expected awaitFlop after preflop, got %q", table.Hand.Phase)
	}

	nextPos := dh.Cursor

	// Finalize reveal without shares should fail.
	res := a.deliverTx(txBytes(t, "dealer/finalize_reveal", map[string]any{
		"tableId": tableID,
		"handId":  handID,
		"pos":     nextPos,
	}), height)
	if res.Code == 0 {
		t.Fatalf("expected finalize_reveal to fail without shares")
	}

	// Submit two valid pub shares for the next community card and finalize the reveal.
	submitPubShare(t, a, height, tableID, handID, epochID, members[0].id, members[0].share, nextPos, 1111)
	submitPubShare(t, a, height, tableID, handID, epochID, members[1].id, members[1].share, nextPos, 2222)
	final := mustOk(t, a.deliverTx(txBytes(t, "dealer/finalize_reveal", map[string]any{
		"tableId": tableID,
		"handId":  handID,
		"pos":     nextPos,
	}), height))

	ev := findEvent(final.Events, "RevealFinalized")
	if ev == nil {
		t.Fatalf("expected RevealFinalized event")
	}
	if got := attr(ev, "cardId"); got != "4" {
		t.Fatalf("expected cardId=4, got %q", got)
	}
	if len(table.Hand.Board) != 1 {
		t.Fatalf("expected board to have 1 card, got %d", len(table.Hand.Board))
	}
}

func TestDealer_SubmitShuffle_UpdatesDeck(t *testing.T) {
	const height = int64(1)

	// Player keys (toy).
	pkAlice := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(999))
	pkBob := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1001))
	a, tableID := setupHeadsUpTableWithPK(t, base64.StdEncoding.EncodeToString(pkAlice.Bytes()), base64.StdEncoding.EncodeToString(pkBob.Bytes()))

	epochID := uint64(1)
	x := ocpcrypto.ScalarFromUint64(111)
	beginEpoch := map[string]any{
		"epochId":   epochID,
		"threshold": 1,
		"pkEpoch":   ocpcrypto.MulBase(x).Bytes(),
		"members": []map[string]any{
			{"validatorId": "v1", "index": uint32(1), "pubShare": ocpcrypto.MulBase(x).Bytes()},
		},
	}
	mustOk(t, a.deliverTx(txBytes(t, "dealer/begin_epoch", beginEpoch), height))

	mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil || table.Hand.Dealer == nil {
		t.Fatalf("expected dealer hand state")
	}
	handID := table.Hand.HandID
	dh := table.Hand.Dealer
	before0 := append([]byte(nil), dh.Deck[0].C1...)

	pkHand, err := ocpcrypto.PointFromBytesCanonical(dh.PKHand)
	if err != nil {
		t.Fatalf("pkHand: %v", err)
	}
	deckIn := make([]ocpcrypto.ElGamalCiphertext, 0, len(dh.Deck))
	for _, c := range dh.Deck {
		c1, _ := ocpcrypto.PointFromBytesCanonical(c.C1)
		c2, _ := ocpcrypto.PointFromBytesCanonical(c.C2)
		deckIn = append(deckIn, ocpcrypto.ElGamalCiphertext{C1: c1, C2: c2})
	}

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 7
	}
	prove, err := ocpshuffle.ShuffleProveV1(pkHand, deckIn, ocpshuffle.ShuffleProveOpts{Seed: seed, Rounds: 4})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	mustOk(t, a.deliverTx(txBytes(t, "dealer/submit_shuffle", map[string]any{
		"tableId":      tableID,
		"handId":       handID,
		"round":        uint16(1),
		"shufflerId":   "v1",
		"proofShuffle": prove.ProofBytes,
	}), height))

	after0 := dh.Deck[0].C1
	if string(after0) == string(before0) {
		t.Fatalf("expected deck to change after shuffle")
	}

	// Compare to prover output for sanity.
	if got := dh.Deck[0].C1; string(got) != string(prove.DeckOut[0].C1.Bytes()) {
		t.Fatalf("deckOut[0].c1 mismatch")
	}
}

func TestDealer_SubmitEncShare_VerifiesEncShareProof(t *testing.T) {
	const height = int64(1)

	// Player key (toy).
	pkAlice := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(999))
	pkBob := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1001))
	a, tableID := setupHeadsUpTableWithPK(t, base64.StdEncoding.EncodeToString(pkAlice.Bytes()), base64.StdEncoding.EncodeToString(pkBob.Bytes()))

	epochID := uint64(1)
	x := ocpcrypto.ScalarFromUint64(123)
	beginEpoch := map[string]any{
		"epochId":   epochID,
		"threshold": 1,
		"pkEpoch":   ocpcrypto.MulBase(x).Bytes(),
		"members": []map[string]any{
			{"validatorId": "v1", "index": uint32(1), "pubShare": ocpcrypto.MulBase(x).Bytes()},
		},
	}
	mustOk(t, a.deliverTx(txBytes(t, "dealer/begin_epoch", beginEpoch), height))

	mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))
	handID := a.st.Tables[tableID].Hand.HandID
	mustOk(t, a.deliverTx(txBytes(t, "dealer/finalize_deck", map[string]any{
		"tableId": tableID,
		"handId":  handID,
	}), height))

	table := a.st.Tables[tableID]
	dh := table.Hand.Dealer

	pos := dh.HolePos[0] // alice's first hole card in heads-up
	submitEncShare(t, a, height, tableID, handID, epochID, "v1", x, pos, pkAlice, 555, 111, 222)

	if len(dh.EncShares) != 1 {
		t.Fatalf("expected 1 enc share, got %d", len(dh.EncShares))
	}
	if dh.EncShares[0].ValidatorID != "v1" || dh.EncShares[0].Pos != pos {
		t.Fatalf("unexpected enc share record: %+v", dh.EncShares[0])
	}
}

func TestDealer_FullHandFlow_HeadsUp_CheckDown_Settles(t *testing.T) {
	const height = int64(1)

	// Player keys (toy).
	pkAlice := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(999))
	pkBob := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1001))
	a, tableID := setupHeadsUpTableWithPK(t, base64.StdEncoding.EncodeToString(pkAlice.Bytes()), base64.StdEncoding.EncodeToString(pkBob.Bytes()))

	epochID := uint64(1)
	x := ocpcrypto.ScalarFromUint64(777)
	member := testMember{id: "v1", index: 1, share: x}
	beginEpoch := map[string]any{
		"epochId":   epochID,
		"threshold": 1,
		"pkEpoch":   ocpcrypto.MulBase(x).Bytes(),
		"members": []map[string]any{
			{"validatorId": "v1", "index": uint32(1), "pubShare": ocpcrypto.MulBase(x).Bytes()},
		},
	}
	mustOk(t, a.deliverTx(txBytes(t, "dealer/begin_epoch", beginEpoch), height))

	mustOk(t, a.deliverTx(txBytes(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}), height))
	table := a.st.Tables[tableID]
	handID := table.Hand.HandID
	mustOk(t, a.deliverTx(txBytes(t, "dealer/finalize_deck", map[string]any{
		"tableId": tableID,
		"handId":  handID,
	}), height))

	// Provide encrypted shares for 4 hole cards (threshold 1).
	dh := table.Hand.Dealer
	for seat := 0; seat < 2; seat++ {
		pkPlayer := pkAlice
		if seat == 1 {
			pkPlayer = pkBob
		}
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

	// Preflop: SB calls, BB checks -> await flop.
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "call"}), height))
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "check"}), height))
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

	// Flop: check/check -> await turn.
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "check"}), height))
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "check"}), height))
	if table.Hand.Phase != state.PhaseAwaitTurn {
		t.Fatalf("expected awaitTurn, got %q", table.Hand.Phase)
	}

	// Turn (1 reveal), then check/check -> await river.
	revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9010)
	if table.Hand.Phase != state.PhaseBetting || table.Hand.Street != state.StreetTurn {
		t.Fatalf("expected betting turn, got phase=%q street=%q", table.Hand.Phase, table.Hand.Street)
	}
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "check"}), height))
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "check"}), height))
	if table.Hand.Phase != state.PhaseAwaitRiver {
		t.Fatalf("expected awaitRiver, got %q", table.Hand.Phase)
	}

	// River (1 reveal), then check/check -> await showdown.
	revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9020)
	if table.Hand.Phase != state.PhaseBetting || table.Hand.Street != state.StreetRiver {
		t.Fatalf("expected betting river, got phase=%q street=%q", table.Hand.Phase, table.Hand.Street)
	}
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "bob", "tableId": tableID, "action": "check"}), height))
	mustOk(t, a.deliverTx(txBytes(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "check"}), height))
	if table.Hand.Phase != state.PhaseAwaitShowdown {
		t.Fatalf("expected awaitShowdown, got %q", table.Hand.Phase)
	}

	// Reveal all eligible hole cards (4 reveals), which should settle the hand.
	revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9031)
	revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9032)
	revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9033)
	final := revealNextWithMember(t, a, height, tableID, handID, epochID, member, 9034)
	if findEvent(final.Events, "HandCompleted") == nil {
		t.Fatalf("expected HandCompleted event after last hole reveal")
	}

	if table.Hand != nil {
		t.Fatalf("expected hand to be cleared after settlement")
	}

	// Chip conservation: stacks on table should equal the 2 buy-ins (100+100).
	var sum uint64
	for i := 0; i < 2; i++ {
		sum += a.st.Tables[tableID].Seats[i].Stack
	}
	if sum != 200 {
		t.Fatalf("chip conservation failed: sum=%d want=200", sum)
	}
}
