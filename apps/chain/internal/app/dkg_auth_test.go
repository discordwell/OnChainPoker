package app

import (
	"bytes"
	"crypto/ed25519"
	"encoding/binary"
	"testing"

	"onchainpoker/apps/chain/internal/ocpcrypto"
	"onchainpoker/apps/chain/internal/state"
)

func TestDKGTimeout_MissingCommits_AbortsAndSlashesBond(t *testing.T) {
	height := int64(1)
	a := newTestApp(t)

	// Register + bond 3 validators.
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

	// Begin DKG epoch 1, threshold=2. Only v1 will commit.
	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/begin_epoch", map[string]any{
		"epochId":         uint64(1),
		"committeeSize":   uint32(3),
		"threshold":       uint8(2),
		"commitBlocks":    uint64(1),
		"complaintBlocks": uint64(1),
		"revealBlocks":    uint64(1),
		"finalizeBlocks":  uint64(1),
	}, "v1"), height, 0))

	commitments := [][]byte{
		ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes(),
		ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(2)).Bytes(),
	}
	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/dkg_commit", map[string]any{
		"epochId":     uint64(1),
		"dealerId":    "v1",
		"commitments": commitments,
	}, "v1"), height, 0))

	// After commitDeadline, dkg_timeout should slash missing committers and abort below threshold.
	timeoutH := int64(3)
	mustOk(t, a.deliverTx(txBytes(t, "dealer/dkg_timeout", map[string]any{
		"epochId": uint64(1),
	}), timeoutH, 0))

	if a.st.Dealer == nil || a.st.Dealer.DKG != nil {
		t.Fatalf("expected dkg cleared after abort")
	}

	v2 := findValidator(a.st, "v2")
	v3 := findValidator(a.st, "v3")
	if v2 == nil || v3 == nil {
		t.Fatalf("expected validators present")
	}
	if v2.Status != state.ValidatorJailed || v3.Status != state.ValidatorJailed {
		t.Fatalf("expected v2/v3 jailed")
	}
	if v2.Bond != 50 || v3.Bond != 50 {
		t.Fatalf("expected v2/v3 bond slashed to 50/50, got %d/%d", v2.Bond, v3.Bond)
	}
	if got := a.st.Balance(treasuryAccount); got != 100 {
		t.Fatalf("expected treasury balance 100, got %d", got)
	}
}

func TestDKGComplaintInvalid_SignedShareEvidence_SlashesDealer(t *testing.T) {
	height := int64(1)
	a := newTestApp(t)

	// Register + bond 2 validators.
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

	// Begin DKG epoch 1, threshold=2.
	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/begin_epoch", map[string]any{
		"epochId":         uint64(1),
		"committeeSize":   uint32(2),
		"threshold":       uint8(2),
		"commitBlocks":    uint64(1),
		"complaintBlocks": uint64(5),
		"revealBlocks":    uint64(5),
		"finalizeBlocks":  uint64(5),
	}, "v1"), height, 0))

	// Commitments for v1: f(x)=5 + 7x (threshold=2).
	commitmentsV1 := [][]byte{
		ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(5)).Bytes(),
		ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(7)).Bytes(),
	}
	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/dkg_commit", map[string]any{
		"epochId":     uint64(1),
		"dealerId":    "v1",
		"commitments": commitmentsV1,
	}, "v1"), height, 0))

	// Commitments for v2 (any valid poly).
	commitmentsV2 := [][]byte{
		ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(9)).Bytes(),
		ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(11)).Bytes(),
	}
	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/dkg_commit", map[string]any{
		"epochId":     uint64(1),
		"dealerId":    "v2",
		"commitments": commitmentsV2,
	}, "v2"), height, 0))

	// Build an invalid share message from v1 to v2 and sign it with v1's ed25519 key.
	share := ocpcrypto.ScalarFromUint64(123).Bytes() // expected is 19 at x=2; 123 is invalid
	body := []byte(dkgShareMsgMagicV1)
	epochLE := make([]byte, 8)
	binary.LittleEndian.PutUint64(epochLE, 1)
	body = append(body, epochLE...)
	body = append(body, 0, 0) // dealerLen placeholder
	body = append(body, []byte("v1")...)
	binary.LittleEndian.PutUint16(body[4+8:], uint16(len("v1")))
	body = append(body, 0, 0) // toLen placeholder
	body = append(body, []byte("v2")...)
	binary.LittleEndian.PutUint16(body[4+8+2+len("v1"):], uint16(len("v2")))
	body = append(body, share...)

	_, privV1 := testEd25519Key("v1")
	toSign := append(append([]byte(dkgShareMsgDomainV1), 0), body...)
	sig := ed25519.Sign(privV1, toSign)
	shareMsg := append(append([]byte(nil), body...), sig...)

	// Complaint phase begins at height==commitDeadline (start=1, commitBlocks=1 => commitDeadline=2).
	complaintH := int64(2)
	mustOk(t, a.deliverTx(txBytesSigned(t, "dealer/dkg_complaint_invalid", map[string]any{
		"epochId":      uint64(1),
		"complainerId": "v2",
		"dealerId":     "v1",
		"shareMsg":     shareMsg,
	}, "v2"), complaintH, 0))

	dkg := a.st.Dealer.DKG
	if dkg == nil {
		t.Fatalf("expected dkg still in progress")
	}
	if !dkgIsSlashed(dkg, "v1") {
		t.Fatalf("expected v1 slashed in dkg state")
	}
	v1 := findValidator(a.st, "v1")
	if v1 == nil {
		t.Fatalf("expected v1 validator record")
	}
	if v1.Status != state.ValidatorJailed {
		t.Fatalf("expected v1 jailed")
	}
	if v1.Bond != 50 {
		t.Fatalf("expected v1 bond slashed to 50, got %d", v1.Bond)
	}
	if got := a.st.Balance(treasuryAccount); got != 50 {
		t.Fatalf("expected treasury balance 50, got %d", got)
	}

	// The share evidence should round-trip through decode as sanity.
	got, err := decodeDKGShareMsgV1(shareMsg)
	if err != nil {
		t.Fatalf("decode shareMsg: %v", err)
	}
	if got.EpochID != 1 || got.DealerID != "v1" || got.ToID != "v2" {
		t.Fatalf("unexpected shareMsg decode: %+v", got)
	}
	if !bytes.Equal(got.Share, share) {
		t.Fatalf("share bytes mismatch")
	}
}

func TestDealerBeginEpochRequiresActiveValidatorSigner(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	pub, _ := testEd25519Key("v1")
	mintTestTokens(t, a, height, "v1", 1000)
	mustOk(t, a.deliverTx(txBytesSigned(t, "staking/register_validator", map[string]any{
		"validatorId": "v1",
		"pubKey":      []byte(pub),
	}, "v1"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "staking/bond", map[string]any{
		"validatorId": "v1",
		"amount":      uint64(100),
	}, "v1"), height, 0))

	v := findValidator(a.st, "v1")
	if v == nil {
		t.Fatalf("expected v1 validator")
	}
	v.Status = state.ValidatorJailed

	res := a.deliverTx(txBytesSigned(t, "dealer/begin_epoch", map[string]any{
		"epochId":         uint64(1),
		"committeeSize":   uint32(1),
		"threshold":       uint8(1),
		"commitBlocks":    uint64(1),
		"complaintBlocks": uint64(1),
		"revealBlocks":    uint64(1),
		"finalizeBlocks":  uint64(1),
	}, "v1"), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected begin_epoch to fail for jailed validator")
	}
	if a.st.Dealer.DKG != nil {
		t.Fatalf("dkg should not be set on authorization failure")
	}
	if a.st.Dealer.NextEpochID != 1 {
		t.Fatalf("nextEpochID should not change on authorization failure")
	}
}

func TestDealerBeginEpochRequiresRegisteredValidatorSigner(t *testing.T) {
	a := newTestApp(t)
	res := a.deliverTx(txBytesSigned(t, "dealer/begin_epoch", map[string]any{
		"epochId":       uint64(1),
		"committeeSize": uint32(1),
		"threshold":     uint8(1),
	}, "alice"), 1, 0)
	if res.Code == 0 {
		t.Fatalf("expected begin_epoch to fail for non-validator signer")
	}
	if a.st.Dealer.DKG != nil {
		t.Fatalf("dkg should not be set on authorization failure")
	}
	if a.st.Dealer.NextEpochID != 1 {
		t.Fatalf("nextEpochID should not change on authorization failure")
	}
}
