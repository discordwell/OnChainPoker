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
	vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes)
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
		vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes)
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

	vr := ShuffleVerifyV1(pk, deckIn, bad)
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

	vr := ShuffleVerifyV1(pk, deckIn, bad)
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

	vr := ShuffleVerifyV1(pk, deckIn, bad)
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

	vr := ShuffleVerifyV1(pk, deckIn, res.ProofBytes)
	if !vr.OK {
		t.Fatalf("verify failed: %s", vr.Error)
	}
}
