package keeper

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	sdk "github.com/cosmos/cosmos-sdk/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

// aeadFixture wires up a DKG state inside the complaint window with one
// dealer→recipient encrypted share already stored. Both dealer and recipient
// are bonded validators so applyPenalty can resolve their operator addresses.
type aeadFixture struct {
	dealer       string // valoper
	complainer   string // valoper
	complainerSk ocpcrypto.Scalar
	pkR          ocpcrypto.Point
	U            ocpcrypto.Point
	V            ocpcrypto.Point
	proofBytes   []byte
	scalarCt     []byte
	scalar       ocpcrypto.Scalar
}

func newAeadFixture(t *testing.T, j uint32) (aeadFixture, context.Context, Keeper, dealertypes.MsgServer) {
	t.Helper()

	dealer, _, commitments, skR, pkRBytes, req := encShareTestSetup(t, j)
	// encShareTestSetup pins addresses to 0x31 / 0x32; mirror in the bonded set.
	dealerVal := makeBondedValidatorForDealerTest(t, dealer, 1, 0x31)
	recipientValoper := sdk.ValAddress(bytes.Repeat([]byte{0x32}, 20)).String()
	recipientVal := makeBondedValidatorForDealerTest(t, recipientValoper, 1, 0x32)

	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(
		t,
		time.Unix(100, 0).UTC(),
		150, // inside [CommitDeadline=100, ComplaintDeadline=200]
		[]stakingtypes.Validator{dealerVal, recipientVal},
	)

	pkR, err := ocpcrypto.PointFromBytesCanonical(pkRBytes)
	require.NoError(t, err)
	U, err := ocpcrypto.PointFromBytesCanonical(req.U)
	require.NoError(t, err)
	V, err := ocpcrypto.PointFromBytesCanonical(req.V)
	require.NoError(t, err)

	// Place the encrypted share directly into state. We bypass DkgEncryptedShare
	// because some test cases want the stored ct to be malformed in ways the
	// submitter would have caught — we're testing the complaint path, not the
	// submit-side guard.
	dkg := newDkgWithCommit(dealer, recipientValoper, j, commitments, pkRBytes)
	dkg.EncryptedShares = []dealertypes.DealerDKGEncryptedShare{
		{
			Dealer:         dealer,
			RecipientIndex: j,
			U:              req.U,
			V:              req.V,
			Proof:          req.Proof,
			ScalarCt:       req.ScalarCt,
		},
	}
	require.NoError(t, k.SetDKG(ctx, dkg))

	s, err := ocpcrypto.DkgScalarAeadOpen(ocpcrypto.MulPoint(U, skR), req.ScalarCt, req.Proof)
	require.NoError(t, err)

	return aeadFixture{
		dealer:       dealer,
		complainer:   recipientValoper,
		complainerSk: skR,
		pkR:          pkR,
		U:            U,
		V:            V,
		proofBytes:   req.Proof,
		scalarCt:     req.ScalarCt,
		scalar:       s,
	}, ctx, k, ms
}

// dleqProveDh derives dh = skR*U and the Chaum-Pedersen DLEQ proof that
// binds dh to (pkR, U). Mirrors the daemon-side complaint construction.
func dleqProveDh(t *testing.T, f aeadFixture) (dhBytes, proofBytes []byte) {
	t.Helper()
	dh := ocpcrypto.MulPoint(f.U, f.complainerSk)
	cp, err := ocpcrypto.ChaumPedersenProve(
		f.pkR, // y = skR*G
		f.U,   // c1
		dh,    // d = skR*U
		f.complainerSk,
		ocpcrypto.ScalarFromUint64(31337),
	)
	require.NoError(t, err)
	return dh.Bytes(), ocpcrypto.EncodeChaumPedersenProof(cp)
}

// corruptCt flips the last byte (AEAD tag) so DkgScalarAeadOpen fails the
// authenticity check.
func corruptCt(ct []byte) []byte {
	out := append([]byte(nil), ct...)
	out[len(out)-1] ^= 0xFF
	return out
}

// reencryptScalar produces a ciphertext under the same DH key + AAD but for
// a DIFFERENT scalar: AEAD passes, but s'*G != V - dh, so the dealer is
// guilty of a scalar/point-mismatch.
func reencryptScalar(t *testing.T, f aeadFixture, wrong ocpcrypto.Scalar) []byte {
	t.Helper()
	dh := ocpcrypto.MulPoint(f.U, f.complainerSk)
	// Mirror ocpcrypto.EncryptShareScalar: key = SHA256("ocp/v1/dkg/scalar-aead/v1" || dh).
	keySum := sha256.Sum256(append([]byte("ocp/v1/dkg/scalar-aead/v1"), dh.Bytes()...))
	block, err := aes.NewCipher(keySum[:])
	require.NoError(t, err)
	gcm, err := cipher.NewGCM(block)
	require.NoError(t, err)
	iv := make([]byte, gcm.NonceSize())
	return gcm.Seal(nil, iv, wrong.Bytes(), f.proofBytes)
}

func setBlockHeight(ctx context.Context, h int64) context.Context {
	return sdk.WrapSDKContext(sdk.UnwrapSDKContext(ctx).WithBlockHeight(h))
}

// --- Test cases -----------------------------------------------------------

func TestDkgComplaintAEADBad_DealerSlashedOnAEADFail(t *testing.T) {
	f, ctx, k, ms := newAeadFixture(t, 2)

	dkg, err := k.GetDKG(ctx)
	require.NoError(t, err)
	dkg.EncryptedShares[0].ScalarCt = corruptCt(dkg.EncryptedShares[0].ScalarCt)
	require.NoError(t, k.SetDKG(ctx, dkg))

	dh, proof := dleqProveDh(t, f)
	_, err = ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        dh,
		DleqProof:      proof,
	})
	require.NoError(t, err)

	got, err := k.GetDKG(ctx)
	require.NoError(t, err)
	require.Contains(t, got.Slashed, f.dealer, "dealer should be slashed")
	require.NotContains(t, got.Slashed, f.complainer, "complainer should NOT be slashed")
	require.Len(t, got.Complaints, 1)
	require.Equal(t, "aead-bad", got.Complaints[0].Kind)
}

func TestDkgComplaintAEADBad_DealerSlashedOnScalarMismatch(t *testing.T) {
	f, ctx, k, ms := newAeadFixture(t, 2)

	wrongScalar := ocpcrypto.ScalarAdd(f.scalar, ocpcrypto.ScalarFromUint64(1))
	dkg, err := k.GetDKG(ctx)
	require.NoError(t, err)
	dkg.EncryptedShares[0].ScalarCt = reencryptScalar(t, f, wrongScalar)
	require.NoError(t, k.SetDKG(ctx, dkg))

	dh, proof := dleqProveDh(t, f)
	_, err = ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        dh,
		DleqProof:      proof,
	})
	require.NoError(t, err)

	got, err := k.GetDKG(ctx)
	require.NoError(t, err)
	require.Contains(t, got.Slashed, f.dealer, "dealer should be slashed for scalar mismatch")
	require.NotContains(t, got.Slashed, f.complainer)
}

func TestDkgComplaintAEADBad_ComplainerSlashedOnSpurious(t *testing.T) {
	f, ctx, k, ms := newAeadFixture(t, 2)

	// Ciphertext is the valid encShareTestSetup one — AEAD succeeds AND
	// the scalar matches the share point. Filing a complaint = griefing.
	dh, proof := dleqProveDh(t, f)
	_, err := ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        dh,
		DleqProof:      proof,
	})
	require.NoError(t, err)

	got, err := k.GetDKG(ctx)
	require.NoError(t, err)
	require.Contains(t, got.Slashed, f.complainer, "complainer should be slashed for griefing")
	require.NotContains(t, got.Slashed, f.dealer)
	require.Len(t, got.Complaints, 1)
	require.Equal(t, "aead-spurious", got.Complaints[0].Kind)
}

func TestDkgComplaintAEADBad_RejectsBadDLEQ(t *testing.T) {
	f, ctx, k, ms := newAeadFixture(t, 2)

	// Forge a Chaum-Pedersen proof for a dh derived from the WRONG skR.
	// ChaumPedersenVerify will reject (the y=pkR is fixed by on-chain data).
	wrongSk := ocpcrypto.ScalarAdd(f.complainerSk, ocpcrypto.ScalarFromUint64(1))
	wrongDh := ocpcrypto.MulPoint(f.U, wrongSk)
	cp, err := ocpcrypto.ChaumPedersenProve(
		f.pkR,
		f.U,
		wrongDh,
		wrongSk,
		ocpcrypto.ScalarFromUint64(42),
	)
	require.NoError(t, err)

	_, err = ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        wrongDh.Bytes(),
		DleqProof:      ocpcrypto.EncodeChaumPedersenProof(cp),
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "invalid DLEQ proof")

	got, err := k.GetDKG(ctx)
	require.NoError(t, err)
	require.Empty(t, got.Slashed)
	require.Empty(t, got.Complaints)
}

func TestDkgComplaintAEADBad_RejectsBeforeWindow(t *testing.T) {
	f, ctx, _, ms := newAeadFixture(t, 2)

	dh, proof := dleqProveDh(t, f)
	_, err := ms.DkgComplaintAEADBad(setBlockHeight(ctx, 50), &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        dh,
		DleqProof:      proof,
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "not yet allowed")
}

func TestDkgComplaintAEADBad_RejectsAfterWindow(t *testing.T) {
	f, ctx, _, ms := newAeadFixture(t, 2)

	dh, proof := dleqProveDh(t, f)
	_, err := ms.DkgComplaintAEADBad(setBlockHeight(ctx, 250), &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        dh,
		DleqProof:      proof,
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "deadline passed")
}

func TestDkgComplaintAEADBad_RejectsDuplicate(t *testing.T) {
	f, ctx, _, ms := newAeadFixture(t, 2)
	dh, proof := dleqProveDh(t, f)

	_, err := ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        dh,
		DleqProof:      proof,
	})
	require.NoError(t, err)

	_, err = ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        dh,
		DleqProof:      proof,
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "already filed")
}

// TestDkgComplaintAEADBad_DoubleComplaintSlashesOnce guards against the
// economic bug where a dealer who ships malformed scalar_ct to multiple
// recipients gets slashed once per complaint (rather than once total).
// Sequence: dealer corrupts one ct → recipient R1 (index 2) files AEAD-bad,
// dealer joins dkg.Slashed and applyPenalty fires. Then we synthesize a
// second valid AEAD-bad complaint against the same dealer from a different
// recipient (index 3 in this fixture) and assert the second call accepts
// the complaint but does NOT call applyPenalty again — verified indirectly
// by checking dkg.Slashed length stays at 1.
func TestDkgComplaintAEADBad_DoubleComplaintSlashesOnce(t *testing.T) {
	// Build the j=2 fixture and a second j=3 complainant against the same
	// dealer. encShareTestSetup uses the same dealer (0x31) and a recipient
	// addressed by index — we'll reuse the same recipient validator entry
	// but file at index 3 to keep the test self-contained. Easier: reuse the
	// same recipient (index 2) and submit two complaints from two distinct
	// complainants — but findDKGComplaint dedupes by (complainer, dealer)
	// pair so we'd need different complainers. The fixture only seeds one
	// recipient; add a second recipient manually.
	f, ctx, k, ms := newAeadFixture(t, 2)

	// Corrupt the stored share so both complaints would be "dealer-fault".
	dkg, err := k.GetDKG(ctx)
	require.NoError(t, err)
	dkg.EncryptedShares[0].ScalarCt = corruptCt(dkg.EncryptedShares[0].ScalarCt)

	// Add a SECOND recipient and a second matching encrypted share. The
	// share's (u, v, proof, ct) are reused — the chain handler only verifies
	// the DLEQ proof for THIS complainant's pkR and the stored U, V.
	r2Valoper := sdk.ValAddress(bytes.Repeat([]byte{0x33}, 20)).String()
	r2Sk := ocpcrypto.ScalarFromUint64(9003)
	r2Pk := ocpcrypto.MulBase(r2Sk).Bytes()
	dkg.Members = append(dkg.Members, dealertypes.DealerMember{
		Validator:       r2Valoper,
		Index:           3,
		EphemeralPubkey: r2Pk,
	})
	dkg.EncryptedShares = append(dkg.EncryptedShares, dealertypes.DealerDKGEncryptedShare{
		Dealer:         f.dealer,
		RecipientIndex: 3,
		U:              f.U.Bytes(),
		V:              f.V.Bytes(),
		Proof:          f.proofBytes,
		ScalarCt:       corruptCt(f.scalarCt),
	})
	require.NoError(t, k.SetDKG(ctx, dkg))

	// First complaint from R1 (index 2) — dealer enters Slashed.
	dh1, proof1 := dleqProveDh(t, f)
	_, err = ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        dh1,
		DleqProof:      proof1,
	})
	require.NoError(t, err)
	got, err := k.GetDKG(ctx)
	require.NoError(t, err)
	require.Equal(t, []string{f.dealer}, got.Slashed)

	// Second complaint from R2 (index 3) — dh and proof for R2's skR.
	dh2 := ocpcrypto.MulPoint(f.U, r2Sk)
	cp2, err := ocpcrypto.ChaumPedersenProve(
		ocpcrypto.MulBase(r2Sk),
		f.U,
		dh2,
		r2Sk,
		ocpcrypto.ScalarFromUint64(7777),
	)
	require.NoError(t, err)
	_, err = ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     r2Valoper,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 3,
		DhShare:        dh2.Bytes(),
		DleqProof:      ocpcrypto.EncodeChaumPedersenProof(cp2),
	})
	require.NoError(t, err)

	// dkg.Slashed must still contain the dealer exactly once. The second
	// complaint records but does NOT re-slash.
	got, err = k.GetDKG(ctx)
	require.NoError(t, err)
	require.Equal(t, []string{f.dealer}, got.Slashed, "dealer must be slashed exactly once across multiple AEAD complaints")
	require.Len(t, got.Complaints, 2, "both complaints record")
}

func TestDkgComplaintAEADBad_RejectsBadLengths(t *testing.T) {
	f, ctx, _, ms := newAeadFixture(t, 2)
	dh, proof := dleqProveDh(t, f)

	// dh_share wrong length.
	shortDh := dh[:30]
	_, err := ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        shortDh,
		DleqProof:      proof,
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "dh_share must be")

	// dleq_proof wrong length.
	shortProof := proof[:94]
	_, err = ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 2,
		DhShare:        dh,
		DleqProof:      shortProof,
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "dleq_proof must be 96 bytes")
}

func TestDkgComplaintAEADBad_RejectsRecipientIndexMismatch(t *testing.T) {
	f, ctx, _, ms := newAeadFixture(t, 2)
	dh, proof := dleqProveDh(t, f)

	_, err := ms.DkgComplaintAEADBad(ctx, &dealertypes.MsgDkgComplaintAEADBad{
		Complainer:     f.complainer,
		EpochId:        42,
		Dealer:         f.dealer,
		RecipientIndex: 99, // not the complainer's actual member index (2)
		DhShare:        dh,
		DleqProof:      proof,
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "recipient_index")
}
