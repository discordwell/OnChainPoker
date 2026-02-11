package app

import (
	"crypto/ed25519"
	"encoding/binary"
	"testing"

	"onchainpoker/apps/chain/internal/ocpcrypto"
)

func setupActiveDealerEpochForTests(t *testing.T, a *OCPApp, height int64) {
	t.Helper()

	for _, id := range []string{"v1", "v2"} {
		pub, _ := testEd25519Key(id)
		mintTestTokens(t, a, height, id, 1000)
		mustOk(t, a.deliverTx(txBytesSigned(t, "staking/register_validator", map[string]any{
			"validatorId": id,
			"pubKey":      []byte(pub),
		}, id), height, 0))
		mustOk(t, a.deliverTx(txBytesSigned(t, "staking/bond", map[string]any{
			"validatorId": id,
			"amount":      uint64(100),
		}, id), height, 0))
	}

	mustOk(t, a.deliverTx(txBytes(t, "dealer/begin_epoch", map[string]any{
		"epochId":         uint64(1),
		"committeeSize":   uint32(2),
		"threshold":       uint8(1),
		"commitBlocks":    uint64(1),
		"complaintBlocks": uint64(1),
		"revealBlocks":    uint64(1),
		"finalizeBlocks":  uint64(1),
	}), height, 0))

	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/dkg_commit", map[string]any{
		"epochId":  uint64(1),
		"dealerId": "v1",
		"commitments": [][]byte{
			ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(5)).Bytes(),
		},
	}, "v1"), height, 0))

	mustOk(t, a.deliverTx(txBytes(t, "dealer/finalize_epoch", map[string]any{
		"epochId": uint64(1),
	}), height+5, 0))

	if a.st.Dealer == nil || a.st.Dealer.Epoch == nil {
		t.Fatalf("expected active dealer epoch")
	}
}

func makeInvalidShareMsgSignedBy(t *testing.T, dealerID, toID string, epochID uint64, share []byte) []byte {
	t.Helper()

	body := []byte(dkgShareMsgMagicV1)
	epochLE := make([]byte, 8)
	binary.LittleEndian.PutUint64(epochLE, epochID)
	body = append(body, epochLE...)

	body = append(body, 0, 0)
	body = append(body, []byte(dealerID)...)
	binary.LittleEndian.PutUint16(body[4+8:], uint16(len(dealerID)))

	body = append(body, 0, 0)
	body = append(body, []byte(toID)...)
	binary.LittleEndian.PutUint16(body[4+8+2+len(dealerID):], uint16(len(toID)))

	body = append(body, share...)

	_, priv := testEd25519Key(dealerID)
	toSign := append(append([]byte(dkgShareMsgDomainV1), 0), body...)
	sig := ed25519.Sign(priv, toSign)
	return append(append([]byte(nil), body...), sig...)
}

func TestAtomicity_FailedSitDoesNotDebitBalance(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	mintTestTokens(t, a, height, "alice", 1000)
	registerTestAccount(t, a, height, "alice")

	createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":    "alice",
		"smallBlind": 1,
		"bigBlind":   2,
		"minBuyIn":   100,
		"maxBuyIn":   1000,
	}, "alice"), height, 0))
	tableID := parseU64(t, attr(findEvent(createRes.Events, "TableCreated"), "tableId"))

	before := a.st.Balance("alice")
	res := a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{
		"player":   "alice",
		"tableId":  tableID,
		"seat":     0,
		"buyIn":    100,
		"pkPlayer": "not-base64",
	}, "alice"), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected sit to fail")
	}

	after := a.st.Balance("alice")
	if after != before {
		t.Fatalf("balance changed on failed sit: before=%d after=%d", before, after)
	}
	if a.st.Tables[tableID].Seats[0] != nil {
		t.Fatalf("seat should remain empty on failed sit")
	}
}

func TestAtomicity_FailedStartHandDoesNotLeavePartialHand(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)
	setupActiveDealerEpochForTests(t, a, height)

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
	}, "alice"), height, 0))
	tableID := parseU64(t, attr(findEvent(createRes.Events, "TableCreated"), "tableId"))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 100}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 100}, "bob"), height, 0))

	res := a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}, "alice"), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected start_hand to fail due to missing pkPlayer")
	}

	tbl := a.st.Tables[tableID]
	if tbl.Hand != nil {
		t.Fatalf("failed start_hand must not leave active hand")
	}
	if tbl.NextHandID != 1 {
		t.Fatalf("failed start_hand must not advance nextHandId, got %d", tbl.NextHandID)
	}
	if tbl.ButtonSeat != -1 {
		t.Fatalf("failed start_hand must not advance button, got %d", tbl.ButtonSeat)
	}
	if tbl.Seats[0] == nil || tbl.Seats[1] == nil {
		t.Fatalf("seats unexpectedly missing")
	}
	if tbl.Seats[0].Stack != 100 || tbl.Seats[1].Stack != 100 {
		t.Fatalf("stacks changed on failed start_hand: %d/%d", tbl.Seats[0].Stack, tbl.Seats[1].Stack)
	}
}

func TestDKG_FinalizeDoesNotDoubleSlashAlreadyPenalizedValidator(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	for _, id := range []string{"v1", "v2", "v3"} {
		pub, _ := testEd25519Key(id)
		mintTestTokens(t, a, height, id, 1000)
		mustOk(t, a.deliverTx(txBytesSigned(t, "staking/register_validator", map[string]any{
			"validatorId": id,
			"pubKey":      []byte(pub),
		}, id), height, 0))
		mustOk(t, a.deliverTx(txBytesSigned(t, "staking/bond", map[string]any{
			"validatorId": id,
			"amount":      uint64(100),
		}, id), height, 0))
	}

	mustOk(t, a.deliverTx(txBytes(t, "dealer/begin_epoch", map[string]any{
		"epochId":         uint64(1),
		"committeeSize":   uint32(3),
		"threshold":       uint8(2),
		"commitBlocks":    uint64(1),
		"complaintBlocks": uint64(5),
		"revealBlocks":    uint64(5),
		"finalizeBlocks":  uint64(5),
	}), height, 0))

	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/dkg_commit", map[string]any{
		"epochId":  uint64(1),
		"dealerId": "v1",
		"commitments": [][]byte{
			ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(5)).Bytes(),
			ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(7)).Bytes(),
		},
	}, "v1"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/dkg_commit", map[string]any{
		"epochId":  uint64(1),
		"dealerId": "v2",
		"commitments": [][]byte{
			ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(9)).Bytes(),
			ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(11)).Bytes(),
		},
	}, "v2"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/dkg_commit", map[string]any{
		"epochId":  uint64(1),
		"dealerId": "v3",
		"commitments": [][]byte{
			ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(13)).Bytes(),
			ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(17)).Bytes(),
		},
	}, "v3"), height, 0))

	shareMsg := makeInvalidShareMsgSignedBy(t, "v1", "v2", 1, ocpcrypto.ScalarFromUint64(123).Bytes())
	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/dkg_complaint_invalid", map[string]any{
		"epochId":      uint64(1),
		"complainerId": "v2",
		"dealerId":     "v1",
		"shareMsg":     shareMsg,
	}, "v2"), int64(2), 0))

	v1 := findValidator(a.st, "v1")
	if v1 == nil {
		t.Fatalf("missing v1")
	}
	if v1.Bond != 50 {
		t.Fatalf("expected v1 bond=50 after complaint slash, got %d", v1.Bond)
	}

	mustOk(t, a.deliverTx(txBytes(t, "dealer/finalize_epoch", map[string]any{
		"epochId": uint64(1),
	}), int64(13), 0))

	if v1.Bond != 50 {
		t.Fatalf("expected no second slash at finalize, got bond=%d", v1.Bond)
	}
}

func TestDKG_BeginEpochFailureDoesNotAdvanceNextEpochID(t *testing.T) {
	a := newTestApp(t)
	if a.st.Dealer == nil {
		t.Fatalf("missing dealer state")
	}
	if a.st.Dealer.NextEpochID != 1 {
		t.Fatalf("unexpected initial next epoch: %d", a.st.Dealer.NextEpochID)
	}

	res := a.deliverTx(txBytes(t, "dealer/begin_epoch", map[string]any{
		"epochId":       uint64(1),
		"committeeSize": uint32(1),
		"threshold":     uint8(1),
	}), 1, 0)
	if res.Code == 0 {
		t.Fatalf("expected begin_epoch to fail with no eligible validators")
	}
	if a.st.Dealer.NextEpochID != 1 {
		t.Fatalf("next epoch advanced on failed begin_epoch: got %d", a.st.Dealer.NextEpochID)
	}
}
