package ocpshuffle

import (
	"testing"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
)

func makeDeck(pk ocpcrypto.Point, n int, seed uint64) []ocpcrypto.ElGamalCiphertext {
	deck := make([]ocpcrypto.ElGamalCiphertext, 0, n)
	for i := 0; i < n; i++ {
		m := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(uint64(i + 1)))
		r := ocpcrypto.ScalarFromUint64(seed + uint64(i+1))
		ct, err := ocpcrypto.ElGamalEncrypt(pk, m, r)
		if err != nil {
			panic(err)
		}
		deck = append(deck, ct)
	}
	return deck
}

func TestShuffleV1_ValidProofVerifiesSmallDeck(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(42)
	pk := ocpcrypto.MulBase(sk)
	deckIn := makeDeck(pk, 10, 123)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 7
	}
	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: 10})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}
	vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes, nil)
	if !vr.OK {
		t.Fatalf("verify failed: %s", vr.Error)
	}
	if len(vr.DeckOut) != 10 {
		t.Fatalf("deckOut length mismatch: %d", len(vr.DeckOut))
	}
}

func TestShuffleV1_VerifySupportsOddAndEvenDeckSizes(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(2468)
	pk := ocpcrypto.MulBase(sk)

	for _, n := range []int{2, 3, 4, 5, 6} {
		deckIn := makeDeck(pk, n, 1000+uint64(n))
		seed := make([]byte, 32)
		for i := range seed {
			seed[i] = byte(17 + n)
		}

		res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: 7})
		if err != nil {
			t.Fatalf("prove n=%d: %v", n, err)
		}
		vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes, nil)
		if !vr.OK {
			t.Fatalf("verify n=%d failed: %s", n, vr.Error)
		}
		if len(vr.DeckOut) != n {
			t.Fatalf("deckOut length mismatch n=%d: %d", n, len(vr.DeckOut))
		}
	}
}

func TestShuffleV1_TamperingOutputDeckBytesFailsVerification(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(123)
	pk := ocpcrypto.MulBase(sk)
	deckIn := makeDeck(pk, 12, 999)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 9
	}
	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: 12})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	bad := make([]byte, len(res.ProofBytes))
	copy(bad, res.ProofBytes)
	// Header is 1 + 2 + 2 = 5 bytes; deck snapshot begins immediately.
	bad[5+0] ^= 0x01

	vr := ShuffleVerifyV1(pk, deckIn, bad, nil)
	if vr.OK {
		t.Fatalf("expected verify to fail")
	}
}

func TestShuffleV1_WrongPermutationSwappingTwoCiphertextsFailsVerification(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(321)
	pk := ocpcrypto.MulBase(sk)
	n := 10
	deckIn := makeDeck(pk, n, 222)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 8
	}
	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: n})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	bad := make([]byte, len(res.ProofBytes))
	copy(bad, res.ProofBytes)
	headerLen := 5
	ctLen := 64
	a0 := append([]byte(nil), bad[headerLen+0*ctLen:headerLen+1*ctLen]...)
	a1 := append([]byte(nil), bad[headerLen+1*ctLen:headerLen+2*ctLen]...)
	copy(bad[headerLen+0*ctLen:], a1)
	copy(bad[headerLen+1*ctLen:], a0)

	vr := ShuffleVerifyV1(pk, deckIn, bad, nil)
	if vr.OK {
		t.Fatalf("expected verify to fail")
	}
}

func TestShuffleV1_MissingRerandomizationReusingC1FailsVerification(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(777)
	pk := ocpcrypto.MulBase(sk)
	deckIn := makeDeck(pk, 8, 111)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 3
	}
	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: 8})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	bad := make([]byte, len(res.ProofBytes))
	copy(bad, res.ProofBytes)

	headerLen := 5
	ctLen := 64
	in0c1 := deckIn[0].C1.Bytes()
	copy(bad[headerLen+0*ctLen:], in0c1)

	vr := ShuffleVerifyV1(pk, deckIn, bad, nil)
	if vr.OK {
		t.Fatalf("expected verify to fail")
	}
}

func TestShuffleV1_N52SmokeRounds10Verifies(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(999)
	pk := ocpcrypto.MulBase(sk)
	deckIn := makeDeck(pk, 52, 555)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 1
	}
	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: 10})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes, nil)
	if !vr.OK {
		t.Fatalf("verify failed: %s", vr.Error)
	}
}

// ---- WS5 ctx-binding (v2) tests ----

func mustCtx(t *testing.T, tableID uint64, handID uint64, round uint16, shuffler string) []byte {
	t.Helper()
	ctx, err := BuildShuffleContext(tableID, handID, round, shuffler)
	if err != nil {
		t.Fatalf("BuildShuffleContext: %v", err)
	}
	return ctx
}

func TestShuffleV1_CtxBindingV2VerifiesUnderMatchingContext(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(4242)
	pk := ocpcrypto.MulBase(sk)
	n := 6
	deckIn := makeDeck(pk, n, 7777)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 11
	}
	ctx := mustCtx(t, 1, 2, 3, "cosmosvaloper1foo")

	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: n, Context: ctx})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}
	// Header byte 0 must be version=2 (v2 format).
	if res.ProofBytes[0] != ShuffleProofV2Version {
		t.Fatalf("expected v2 header, got %d", res.ProofBytes[0])
	}

	vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes, ctx)
	if !vr.OK {
		t.Fatalf("verify failed: %s", vr.Error)
	}
}

func TestShuffleV1_CtxBindingProofBoundToCtxADoesNotVerifyUnderCtxB(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(4242)
	pk := ocpcrypto.MulBase(sk)
	n := 6
	deckIn := makeDeck(pk, n, 7777)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 12
	}
	ctxA := mustCtx(t, 1, 2, 3, "cosmosvaloper1foo")
	ctxB := mustCtx(t, 1, 2, 3, "cosmosvaloper1bar") // different shuffler

	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: n, Context: ctxA})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes, ctxB)
	if vr.OK {
		t.Fatalf("expected verify to fail under ctxB")
	}
}

func TestShuffleV1_CtxBindingDifferentHandIDRejected(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(4242)
	pk := ocpcrypto.MulBase(sk)
	n := 6
	deckIn := makeDeck(pk, n, 7777)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 13
	}
	ctx2 := mustCtx(t, 1, 2, 1, "v")
	ctx3 := mustCtx(t, 1, 3, 1, "v") // different handId

	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: n, Context: ctx2})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes, ctx3)
	if vr.OK {
		t.Fatalf("expected verify to fail under ctx3")
	}
}

func TestShuffleV1_CtxBindingEmptyContextRejectedAtV2(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(4242)
	pk := ocpcrypto.MulBase(sk)
	deckIn := makeDeck(pk, 4, 7777)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 14
	}
	_, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: 4, Context: []byte{}})
	if err == nil {
		t.Fatalf("expected empty context to be rejected")
	}
}

func TestShuffleV1_CtxBindingV2WithoutCallerCtxFailsVerify(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(4242)
	pk := ocpcrypto.MulBase(sk)
	n := 4
	deckIn := makeDeck(pk, n, 7777)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 15
	}
	ctx := mustCtx(t, 1, 1, 1, "v")
	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: n, Context: ctx})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes, nil)
	if vr.OK {
		t.Fatalf("expected verify to fail when verifier has no context")
	}
}

func TestShuffleV1_CtxBindingV1ProofBackwardCompatible(t *testing.T) {
	// Emits v1 (no context), verifies with nil.
	sk := ocpcrypto.ScalarFromUint64(42)
	pk := ocpcrypto.MulBase(sk)
	deckIn := makeDeck(pk, 10, 123)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 7
	}
	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: 10})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}
	if res.ProofBytes[0] != ShuffleProofV1Version {
		t.Fatalf("expected v1 header, got %d", res.ProofBytes[0])
	}
	vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes, nil)
	if !vr.OK {
		t.Fatalf("verify failed: %s", vr.Error)
	}
}

func TestShuffleV1_CtxBindingV1ProofRejectedWhenCtxSupplied(t *testing.T) {
	sk := ocpcrypto.ScalarFromUint64(42)
	pk := ocpcrypto.MulBase(sk)
	deckIn := makeDeck(pk, 10, 123)

	seed := make([]byte, 32)
	for i := range seed {
		seed[i] = 7
	}
	res, err := ShuffleProveV1(pk, deckIn, ShuffleProveOpts{Seed: seed, Rounds: 10})
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	ctx := mustCtx(t, 1, 1, 1, "v")
	vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes, ctx)
	if vr.OK {
		t.Fatalf("expected verify to fail when v1 proof is given a context")
	}
}

func TestShuffleV1_BuildShuffleContextWireFormat(t *testing.T) {
	// Canonical wire format example (documented in shuffle_v1.go):
	//   u64le(tableId=1) || u64le(handId=2) || u16le(round=3) ||
	//   u16le(shufflerLen=17) || "cosmosvaloper1foo"
	got, err := BuildShuffleContext(1, 2, 3, "cosmosvaloper1foo")
	if err != nil {
		t.Fatalf("BuildShuffleContext: %v", err)
	}
	want := []byte{
		1, 0, 0, 0, 0, 0, 0, 0, // tableId=1 LE
		2, 0, 0, 0, 0, 0, 0, 0, // handId=2 LE
		3, 0, // round=3 LE
		17, 0, // shufflerLen=17 LE
	}
	want = append(want, []byte("cosmosvaloper1foo")...)
	if len(got) != len(want) {
		t.Fatalf("ctx length mismatch: got %d want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("ctx byte %d mismatch: got %x want %x", i, got[i], want[i])
		}
	}
}

func TestShuffleV1_CtxBindingMatchesTSWireFormat(t *testing.T) {
	// Parity check: a specific (tableId, handId, round, shuffler) must hash
	// to the same bytes as the TS side. Length = 8+8+2+2+len(shuffler).
	ctx, err := BuildShuffleContext(0x0102030405060708, 0x0a0b0c0d0e0f1011, 0x1213, "abc")
	if err != nil {
		t.Fatalf("BuildShuffleContext: %v", err)
	}
	if len(ctx) != 8+8+2+2+3 {
		t.Fatalf("unexpected ctx length: %d", len(ctx))
	}
	// first 8 bytes = tableId LE
	expected0 := []byte{0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01}
	for i, b := range expected0 {
		if ctx[i] != b {
			t.Fatalf("tableId LE byte %d: got %x want %x", i, ctx[i], b)
		}
	}
	// next 8 bytes = handId LE
	expected1 := []byte{0x11, 0x10, 0x0f, 0x0e, 0x0d, 0x0c, 0x0b, 0x0a}
	for i, b := range expected1 {
		if ctx[8+i] != b {
			t.Fatalf("handId LE byte %d: got %x want %x", i, ctx[8+i], b)
		}
	}
	// round LE
	if ctx[16] != 0x13 || ctx[17] != 0x12 {
		t.Fatalf("round bytes mismatch: got %x %x", ctx[16], ctx[17])
	}
	// shufflerLen=3 LE
	if ctx[18] != 3 || ctx[19] != 0 {
		t.Fatalf("shufflerLen bytes mismatch")
	}
	if string(ctx[20:]) != "abc" {
		t.Fatalf("shuffler bytes mismatch")
	}
}
