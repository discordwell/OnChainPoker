package ocpcrypto

import (
	"bytes"
	"testing"
)

// buildCommitments builds t Feldman commitments from polynomial coefficients
// a_0..a_{t-1}: C_k = a_k * G. The share at index j is s = Σ a_k * j^k (in
// the scalar field), and S := s*G = Σ C_k * j^k (in the group).
func buildCommitments(t *testing.T, coeffs []Scalar) []Point {
	t.Helper()
	out := make([]Point, len(coeffs))
	for k, a := range coeffs {
		out[k] = MulBase(a)
	}
	return out
}

// evalPolyScalar evaluates Σ a_k * j^k over the scalar field.
func evalPolyScalar(coeffs []Scalar, j uint32) Scalar {
	js := ScalarFromUint64(uint64(j))
	pow := ScalarFromUint64(1)
	acc := ScalarFromUint64(0)
	for _, a := range coeffs {
		acc = ScalarAdd(acc, ScalarMul(a, pow))
		pow = ScalarMul(pow, js)
	}
	return acc
}

// buildShare generates a fresh ElGamal ciphertext for a share-point s*G under
// recipient pkR, returning (U, V, r, s) for test convenience.
func buildShare(t *testing.T, coeffs []Scalar, j uint32, pkR Point, rSeed, sSeedUnused uint64) (Point, Point, Scalar, Scalar) {
	t.Helper()
	_ = sSeedUnused
	s := evalPolyScalar(coeffs, j)
	r := ScalarFromUint64(rSeed)
	U := MulBase(r)
	// V = s*G + r*pkR
	V := PointAdd(MulBase(s), MulPoint(pkR, r))
	return U, V, r, s
}

func TestDkgEncShare_RoundTrip(t *testing.T) {
	coeffs := []Scalar{
		ScalarFromUint64(100),
		ScalarFromUint64(200),
		ScalarFromUint64(300),
	}
	commitments := buildCommitments(t, coeffs)

	skR := ScalarFromUint64(9001)
	pkR := MulBase(skR)
	var j uint32 = 2

	U, V, r, s := buildShare(t, coeffs, j, pkR, 42, 0)
	ws := ScalarFromUint64(11)
	wr := ScalarFromUint64(13)

	p, err := DkgEncShareProve(commitments, j, pkR, U, V, s, r, ws, wr)
	if err != nil {
		t.Fatalf("prove: %v", err)
	}
	ok, err := DkgEncShareVerify(commitments, j, pkR, U, V, p)
	if err != nil {
		t.Fatalf("verify err: %v", err)
	}
	if !ok {
		t.Fatalf("expected verify to succeed")
	}

	// Encode/decode round-trip.
	enc := EncodeDkgEncShareProof(p)
	if len(enc) != DkgEncShareProofBytes {
		t.Fatalf("encoded length: got %d want %d", len(enc), DkgEncShareProofBytes)
	}
	dec, err := DecodeDkgEncShareProof(enc)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !bytes.Equal(EncodeDkgEncShareProof(dec), enc) {
		t.Fatalf("decode(encode) not byte-stable")
	}
	ok, err = DkgEncShareVerify(commitments, j, pkR, U, V, dec)
	if err != nil || !ok {
		t.Fatalf("decoded proof fails verify: %v ok=%v", err, ok)
	}
}

// Sanity: recipient recovers the share point via V - skR*U.
func TestDkgEncShare_RecipientDecryptsSharePoint(t *testing.T) {
	coeffs := []Scalar{ScalarFromUint64(7), ScalarFromUint64(31)}
	commitments := buildCommitments(t, coeffs)

	skR := ScalarFromUint64(555)
	pkR := MulBase(skR)
	var j uint32 = 4

	U, V, _, s := buildShare(t, coeffs, j, pkR, 1234, 0)

	// V - skR*U == s*G
	recovered := PointSub(V, MulPoint(U, skR))
	want := MulBase(s)
	if !PointEq(recovered, want) {
		t.Fatalf("recipient decryption mismatch")
	}

	// Also confirm EvalCommitments(C, j) == s*G, independent check.
	eval, err := EvalCommitments(commitments, j)
	if err != nil {
		t.Fatalf("eval: %v", err)
	}
	if !PointEq(eval, want) {
		t.Fatalf("EvalCommitments mismatch")
	}
}

func TestDkgEncShare_WrongShareScalar(t *testing.T) {
	coeffs := []Scalar{ScalarFromUint64(100), ScalarFromUint64(200)}
	commitments := buildCommitments(t, coeffs)
	pkR := MulBase(ScalarFromUint64(7))
	var j uint32 = 3

	U, V, r, _ := buildShare(t, coeffs, j, pkR, 42, 0)

	// Prove with a wrong witness s' != f(j).
	wrongS := ScalarFromUint64(999999)
	p, err := DkgEncShareProve(commitments, j, pkR, U, V, wrongS, r, ScalarFromUint64(11), ScalarFromUint64(13))
	if err != nil {
		t.Fatalf("prove: %v", err)
	}
	ok, err := DkgEncShareVerify(commitments, j, pkR, U, V, p)
	if err != nil {
		t.Fatalf("verify err: %v", err)
	}
	if ok {
		t.Fatalf("expected wrong-share proof to fail verify")
	}
}

func TestDkgEncShare_WrongRecipientIndex(t *testing.T) {
	coeffs := []Scalar{ScalarFromUint64(7), ScalarFromUint64(11), ScalarFromUint64(13)}
	commitments := buildCommitments(t, coeffs)
	pkR := MulBase(ScalarFromUint64(42))

	// Produce a valid proof for j=2.
	U, V, r, s := buildShare(t, coeffs, 2, pkR, 99, 0)
	p, err := DkgEncShareProve(commitments, 2, pkR, U, V, s, r, ScalarFromUint64(11), ScalarFromUint64(13))
	if err != nil {
		t.Fatalf("prove: %v", err)
	}
	// Verify with j=3 — should fail (different Eval_j).
	ok, _ := DkgEncShareVerify(commitments, 3, pkR, U, V, p)
	if ok {
		t.Fatalf("expected verify under wrong j to fail")
	}
}

func TestDkgEncShare_TamperedCommitments(t *testing.T) {
	coeffs := []Scalar{ScalarFromUint64(100), ScalarFromUint64(200)}
	commitments := buildCommitments(t, coeffs)
	pkR := MulBase(ScalarFromUint64(7))
	var j uint32 = 2
	U, V, r, s := buildShare(t, coeffs, j, pkR, 42, 0)
	p, err := DkgEncShareProve(commitments, j, pkR, U, V, s, r, ScalarFromUint64(11), ScalarFromUint64(13))
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	// Perturb C_1.
	perturbed := make([]Point, len(commitments))
	copy(perturbed, commitments)
	perturbed[1] = PointAdd(perturbed[1], MulBase(ScalarFromUint64(1)))
	ok, _ := DkgEncShareVerify(perturbed, j, pkR, U, V, p)
	if ok {
		t.Fatalf("expected perturbed-C to fail")
	}

	// Truncate commitments (drop highest-degree term) — t changes, transcript changes.
	truncated := commitments[:len(commitments)-1]
	ok, _ = DkgEncShareVerify(truncated, j, pkR, U, V, p)
	if ok {
		t.Fatalf("expected truncated-C to fail")
	}
}

func TestDkgEncShare_TamperedCiphertext(t *testing.T) {
	coeffs := []Scalar{ScalarFromUint64(7), ScalarFromUint64(11)}
	commitments := buildCommitments(t, coeffs)
	pkR := MulBase(ScalarFromUint64(42))
	var j uint32 = 5
	U, V, r, s := buildShare(t, coeffs, j, pkR, 99, 0)
	p, err := DkgEncShareProve(commitments, j, pkR, U, V, s, r, ScalarFromUint64(11), ScalarFromUint64(13))
	if err != nil {
		t.Fatalf("prove: %v", err)
	}

	// Tamper U.
	badU := PointAdd(U, MulBase(ScalarFromUint64(1)))
	ok, _ := DkgEncShareVerify(commitments, j, pkR, badU, V, p)
	if ok {
		t.Fatalf("expected tampered-U to fail")
	}

	// Tamper V.
	badV := PointAdd(V, MulBase(ScalarFromUint64(1)))
	ok, _ = DkgEncShareVerify(commitments, j, pkR, U, badV, p)
	if ok {
		t.Fatalf("expected tampered-V to fail")
	}
}

func TestDkgEncShare_ProofToWrongRecipient(t *testing.T) {
	coeffs := []Scalar{ScalarFromUint64(100), ScalarFromUint64(200)}
	commitments := buildCommitments(t, coeffs)
	pkR1 := MulBase(ScalarFromUint64(42))
	pkR2 := MulBase(ScalarFromUint64(43))

	var j uint32 = 2
	U, V, r, s := buildShare(t, coeffs, j, pkR1, 99, 0)
	p, err := DkgEncShareProve(commitments, j, pkR1, U, V, s, r, ScalarFromUint64(11), ScalarFromUint64(13))
	if err != nil {
		t.Fatalf("prove: %v", err)
	}
	// Verify against pkR2 — the ciphertext was under pkR1, so this must fail.
	ok, _ := DkgEncShareVerify(commitments, j, pkR2, U, V, p)
	if ok {
		t.Fatalf("expected proof to fail against wrong recipient")
	}
}

func TestDkgEncShare_ZeroNonces(t *testing.T) {
	coeffs := []Scalar{ScalarFromUint64(100)}
	commitments := buildCommitments(t, coeffs)
	pkR := MulBase(ScalarFromUint64(7))
	var j uint32 = 2
	U, V, r, s := buildShare(t, coeffs, j, pkR, 42, 0)

	// ws == 0 → rejected
	if _, err := DkgEncShareProve(commitments, j, pkR, U, V, s, r, ScalarFromUint64(0), ScalarFromUint64(13)); err == nil {
		t.Fatalf("expected zero ws to be rejected")
	}
	// wr == 0 → rejected
	if _, err := DkgEncShareProve(commitments, j, pkR, U, V, s, r, ScalarFromUint64(11), ScalarFromUint64(0)); err == nil {
		t.Fatalf("expected zero wr to be rejected")
	}
}

func TestDkgEncShare_ZeroIndex(t *testing.T) {
	coeffs := []Scalar{ScalarFromUint64(1)}
	commitments := buildCommitments(t, coeffs)
	pkR := MulBase(ScalarFromUint64(7))
	U := PointZero()
	V := PointZero()

	if _, err := DkgEncShareProve(commitments, 0, pkR, U, V, ScalarFromUint64(0), ScalarFromUint64(0), ScalarFromUint64(1), ScalarFromUint64(1)); err == nil {
		t.Fatalf("expected j=0 to be rejected in Prove")
	}
	if _, err := EvalCommitments(commitments, 0); err == nil {
		t.Fatalf("expected j=0 to be rejected in EvalCommitments")
	}
}

func TestDkgEncShare_DecodeWrongLength(t *testing.T) {
	// 159 bytes — one short.
	if _, err := DecodeDkgEncShareProof(make([]byte, DkgEncShareProofBytes-1)); err == nil {
		t.Fatalf("expected wrong-length decode to fail")
	}
	// 161 bytes — one long.
	if _, err := DecodeDkgEncShareProof(make([]byte, DkgEncShareProofBytes+1)); err == nil {
		t.Fatalf("expected wrong-length decode to fail")
	}
}
