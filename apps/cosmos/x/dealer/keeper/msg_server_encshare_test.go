package keeper

import (
	"bytes"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

// encShareTestSetup produces a deterministic DkgEncryptedShare request body
// plus the corresponding dealer commit. Signed-by matches the dealer address.
//
// Polynomial: f(x) = a0 + a1*x + a2*x^2 (degree 2 ⇒ threshold 3).
// Recipient index: j. Recipient ElGamal secret: skR.
func encShareTestSetup(t *testing.T, j uint32) (
	dealer string,
	recipient string,
	commitments [][]byte,
	skR ocpcrypto.Scalar,
	pkR []byte,
	req *dealertypes.MsgDkgEncryptedShare,
) {
	t.Helper()

	dealer = sdk.ValAddress(bytes.Repeat([]byte{0x31}, 20)).String()
	recipient = sdk.ValAddress(bytes.Repeat([]byte{0x32}, 20)).String()

	coeffs := []ocpcrypto.Scalar{
		ocpcrypto.ScalarFromUint64(101),
		ocpcrypto.ScalarFromUint64(202),
		ocpcrypto.ScalarFromUint64(303),
	}
	commitmentsPts := make([]ocpcrypto.Point, 0, len(coeffs))
	commitments = make([][]byte, 0, len(coeffs))
	for _, a := range coeffs {
		p := ocpcrypto.MulBase(a)
		commitmentsPts = append(commitmentsPts, p)
		commitments = append(commitments, p.Bytes())
	}

	skR = ocpcrypto.ScalarFromUint64(9002)
	pkRPt := ocpcrypto.MulBase(skR)
	pkR = pkRPt.Bytes()

	// s = f(j) over the scalar field.
	s := ocpcrypto.ScalarFromUint64(0)
	pow := ocpcrypto.ScalarFromUint64(1)
	jScalar := ocpcrypto.ScalarFromUint64(uint64(j))
	for _, a := range coeffs {
		s = ocpcrypto.ScalarAdd(s, ocpcrypto.ScalarMul(a, pow))
		pow = ocpcrypto.ScalarMul(pow, jScalar)
	}

	r := ocpcrypto.ScalarFromUint64(4242)
	U := ocpcrypto.MulBase(r)
	V := ocpcrypto.PointAdd(ocpcrypto.MulBase(s), ocpcrypto.MulPoint(pkRPt, r))
	ws := ocpcrypto.ScalarFromUint64(17)
	wr := ocpcrypto.ScalarFromUint64(19)

	proof, err := ocpcrypto.DkgEncShareProve(commitmentsPts, j, pkRPt, U, V, s, r, ws, wr)
	require.NoError(t, err)
	proofBytes := ocpcrypto.EncodeDkgEncShareProof(proof)

	ct, err := ocpcrypto.EncryptShareScalar(pkRPt, r, s, proofBytes)
	require.NoError(t, err)

	req = &dealertypes.MsgDkgEncryptedShare{
		Dealer:         dealer,
		EpochId:        42,
		RecipientIndex: j,
		U:              U.Bytes(),
		V:              V.Bytes(),
		Proof:          proofBytes,
		ScalarCt:       ct,
	}
	return
}

func newDkgWithCommit(dealer, recipient string, recipientIndex uint32, commitments [][]byte, pkR []byte) *dealertypes.DealerDKG {
	return &dealertypes.DealerDKG{
		EpochId:           42,
		Threshold:         3,
		Members: []dealertypes.DealerMember{
			{Validator: dealer, Index: 1},
			{Validator: recipient, Index: recipientIndex, EphemeralPubkey: pkR},
		},
		StartHeight:       1,
		CommitDeadline:    100,
		ComplaintDeadline: 200,
		RevealDeadline:    300,
		FinalizeDeadline:  400,
		Commits: []dealertypes.DealerDKGCommit{
			{Dealer: dealer, Commitments: commitments},
		},
	}
}

func TestDkgEncryptedShare_HappyPath(t *testing.T) {
	dealer, recipient, commitments, _, pkR, req := encShareTestSetup(t, 2)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, nil)

	require.NoError(t, k.SetDKG(ctx, newDkgWithCommit(dealer, recipient, 2, commitments, pkR)))

	resp, err := ms.DkgEncryptedShare(ctx, req)
	require.NoError(t, err)
	require.NotNil(t, resp)

	dkg, err := k.GetDKG(ctx)
	require.NoError(t, err)
	require.Len(t, dkg.EncryptedShares, 1)
	got := dkg.EncryptedShares[0]
	require.Equal(t, dealer, got.Dealer)
	require.Equal(t, uint32(2), got.RecipientIndex)
	require.Equal(t, req.U, got.U)
	require.Equal(t, req.V, got.V)
	require.Equal(t, req.Proof, got.Proof)
	require.Equal(t, req.ScalarCt, got.ScalarCt)
}

func TestDkgEncryptedShare_BadProofRejected(t *testing.T) {
	// Strategy: build a proof for recipient_index=3, but submit it as a
	// request for recipient_index=2. The proof bytes are structurally valid
	// (all canonical scalars & points) so they pass decoding; the Fiat-Shamir
	// transcript in the verifier rebinds j=2 and the three Sigma checks then
	// fail. This exercises the NIZK verification path, not merely the decode.
	_, _, commitments, _, pkR, req3 := encShareTestSetup(t, 3)

	dealer := sdk.ValAddress(bytes.Repeat([]byte{0x31}, 20)).String()
	recipient := sdk.ValAddress(bytes.Repeat([]byte{0x32}, 20)).String()
	badReq := &dealertypes.MsgDkgEncryptedShare{
		Dealer:         dealer,
		EpochId:        42,
		RecipientIndex: 2, // ← mismatches the proof's bound j=3
		U:              req3.U,
		V:              req3.V,
		Proof:          req3.Proof,
		ScalarCt:       req3.ScalarCt,
	}

	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, nil)
	require.NoError(t, k.SetDKG(ctx, newDkgWithCommit(dealer, recipient, 2, commitments, pkR)))

	_, err := ms.DkgEncryptedShare(ctx, badReq)
	require.ErrorContains(t, err, "invalid encrypted-share proof")
}

func TestDkgEncryptedShare_DuplicateRejected(t *testing.T) {
	dealer, recipient, commitments, _, pkR, req := encShareTestSetup(t, 2)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, nil)

	require.NoError(t, k.SetDKG(ctx, newDkgWithCommit(dealer, recipient, 2, commitments, pkR)))

	_, err := ms.DkgEncryptedShare(ctx, req)
	require.NoError(t, err)

	_, err = ms.DkgEncryptedShare(ctx, req)
	require.ErrorContains(t, err, "already submitted")
}

func TestDkgEncryptedShare_DealerToSelfRejected(t *testing.T) {
	dealer, _, commitments, _, pkR, req := encShareTestSetup(t, 1) // j=1 == dealer's own index
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, nil)

	dkg := &dealertypes.DealerDKG{
		EpochId:           42,
		Threshold:         3,
		Members: []dealertypes.DealerMember{
			{Validator: dealer, Index: 1, EphemeralPubkey: pkR},
		},
		StartHeight:       1,
		CommitDeadline:    100,
		ComplaintDeadline: 200,
		RevealDeadline:    300,
		FinalizeDeadline:  400,
		Commits: []dealertypes.DealerDKGCommit{
			{Dealer: dealer, Commitments: commitments},
		},
	}
	require.NoError(t, k.SetDKG(ctx, dkg))

	_, err := ms.DkgEncryptedShare(ctx, req)
	require.ErrorContains(t, err, "cannot address itself")
}

func TestDkgEncryptedShare_NoEphemeralPubkeyRejected(t *testing.T) {
	dealer, recipient, commitments, _, _, req := encShareTestSetup(t, 2)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, nil)

	// Same dkg as happy path, but recipient has no ephemeral pubkey.
	dkg := newDkgWithCommit(dealer, recipient, 2, commitments, nil)
	require.NoError(t, k.SetDKG(ctx, dkg))

	_, err := ms.DkgEncryptedShare(ctx, req)
	require.ErrorContains(t, err, "ephemeral_pubkey")
}

func TestDkgEncryptedShare_AfterRevealDeadlineRejected(t *testing.T) {
	dealer, recipient, commitments, _, pkR, req := encShareTestSetup(t, 2)
	// Block height past the reveal deadline (300 in the test fixture).
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 301, nil)
	require.NoError(t, k.SetDKG(ctx, newDkgWithCommit(dealer, recipient, 2, commitments, pkR)))

	_, err := ms.DkgEncryptedShare(ctx, req)
	require.ErrorContains(t, err, "reveal deadline passed")
}

// TestDkgCommit_AcceptsEphemeralPubkey confirms the v2 dealer-daemon path:
// MsgDkgCommit carries the per-epoch ephemeral pubkey and the keeper
// persists it onto the DealerMember record.
func TestDkgCommit_AcceptsEphemeralPubkey(t *testing.T) {
	dealer := sdk.ValAddress(bytes.Repeat([]byte{0x41}, 20)).String()
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 5, nil)

	require.NoError(t, k.SetDKG(ctx, &dealertypes.DealerDKG{
		EpochId:           8,
		Threshold:         1,
		Members:           []dealertypes.DealerMember{{Validator: dealer, Index: 1}},
		StartHeight:       1,
		CommitDeadline:    10,
		ComplaintDeadline: 20,
		RevealDeadline:    30,
		FinalizeDeadline:  40,
	}))

	// Fresh ephemeral key for the dealer.
	skR := ocpcrypto.ScalarFromUint64(7777)
	pkR := ocpcrypto.MulBase(skR).Bytes()

	commitment := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()
	_, err := ms.DkgCommit(ctx, &dealertypes.MsgDkgCommit{
		Dealer:          dealer,
		EpochId:         8,
		Commitments:     [][]byte{commitment},
		EphemeralPubkey: pkR,
	})
	require.NoError(t, err)

	dkg, err := k.GetDKG(ctx)
	require.NoError(t, err)
	require.Equal(t, pkR, dkg.Members[0].EphemeralPubkey)
}
