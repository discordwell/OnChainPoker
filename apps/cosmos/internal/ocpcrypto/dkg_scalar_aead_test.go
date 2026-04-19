package ocpcrypto

import (
	"bytes"
	"testing"
)

// scalarAeadSetup builds a fully consistent (commitments, NIZK, ciphertext)
// bundle for the recipient index j. Mirrors the TS test setup.
func scalarAeadSetup(t *testing.T, j uint32) (
	commitments []Point,
	pkR Point,
	skR Scalar,
	r Scalar,
	s Scalar,
	u Point,
	v Point,
	proofBytes []byte,
) {
	t.Helper()
	coeffs := []Scalar{ScalarFromUint64(100), ScalarFromUint64(200), ScalarFromUint64(300)}
	commitments = buildCommitments(t, coeffs)
	skR = ScalarFromUint64(9001)
	pkR = MulBase(skR)
	u, v, r, s = buildShare(t, coeffs, j, pkR, 42, 0)
	p, err := DkgEncShareProve(commitments, j, pkR, u, v, s, r, ScalarFromUint64(11), ScalarFromUint64(13))
	if err != nil {
		t.Fatalf("prove: %v", err)
	}
	proofBytes = EncodeDkgEncShareProof(p)
	return
}

func TestDkgScalarAead_RoundTrip(t *testing.T) {
	_, pkR, skR, r, s, u, _, proofBytes := scalarAeadSetup(t, 2)

	ct, err := EncryptShareScalar(pkR, r, s, proofBytes)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if len(ct) != DkgScalarAeadCtBytes {
		t.Fatalf("ct length: got %d want %d", len(ct), DkgScalarAeadCtBytes)
	}

	got, err := DecryptShareScalar(skR, u, proofBytes, ct)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if !bytes.Equal(got.Bytes(), s.Bytes()) {
		t.Fatalf("decrypted scalar mismatch")
	}
}

func TestDkgScalarAead_TamperedCtFails(t *testing.T) {
	_, pkR, skR, r, s, u, _, proofBytes := scalarAeadSetup(t, 2)
	ct, err := EncryptShareScalar(pkR, r, s, proofBytes)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	// Tamper ciphertext body.
	bad := append([]byte{}, ct...)
	bad[0] ^= 0x01
	if _, err := DecryptShareScalar(skR, u, proofBytes, bad); err == nil {
		t.Fatalf("expected tamper-body to fail")
	}

	// Tamper tag region.
	bad = append([]byte{}, ct...)
	bad[40] ^= 0x01
	if _, err := DecryptShareScalar(skR, u, proofBytes, bad); err == nil {
		t.Fatalf("expected tamper-tag to fail")
	}
}

func TestDkgScalarAead_WrongRecipientFails(t *testing.T) {
	_, pkR, _, r, s, u, _, proofBytes := scalarAeadSetup(t, 2)
	ct, err := EncryptShareScalar(pkR, r, s, proofBytes)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	wrongSkR := ScalarFromUint64(8999)
	if _, err := DecryptShareScalar(wrongSkR, u, proofBytes, ct); err == nil {
		t.Fatalf("expected wrong-skR to fail")
	}
}

func TestDkgScalarAead_WrongAadFails(t *testing.T) {
	_, pkR, skR, r, s, u, _, proofBytes := scalarAeadSetup(t, 2)
	ct, err := EncryptShareScalar(pkR, r, s, proofBytes)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	// Flip one byte of the proof bytes and use it as AAD.
	wrongProof := append([]byte{}, proofBytes...)
	wrongProof[0] ^= 0x01
	if _, err := DecryptShareScalar(skR, u, wrongProof, ct); err == nil {
		t.Fatalf("expected wrong-AAD to fail")
	}
}

func TestDkgScalarAead_WrongCtLengthFails(t *testing.T) {
	_, pkR, skR, r, s, u, _, proofBytes := scalarAeadSetup(t, 2)
	ct, err := EncryptShareScalar(pkR, r, s, proofBytes)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if _, err := DecryptShareScalar(skR, u, proofBytes, ct[:DkgScalarAeadCtBytes-1]); err == nil {
		t.Fatalf("expected wrong-length to fail")
	}
}

// TestDkgScalarAead_ShareScalarConsistency checks that decrypted s*G matches
// the NIZK-verified share point (v - skR*u). This is the recipient-side
// sanity check that catches a dishonest dealer who submits a scalar
// inconsistent with the NIZK-verified share point.
func TestDkgScalarAead_ShareScalarConsistency(t *testing.T) {
	_, pkR, skR, r, s, u, v, proofBytes := scalarAeadSetup(t, 3)
	ct, err := EncryptShareScalar(pkR, r, s, proofBytes)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	decS, err := DecryptShareScalar(skR, u, proofBytes, ct)
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}

	// Share point from scalar: decS*G.
	sharePointFromScalar := MulBase(decS)
	// Share point from ElGamal: v - skR*u.
	sharePointFromElGamal := PointSub(v, MulPoint(u, skR))
	if !PointEq(sharePointFromScalar, sharePointFromElGamal) {
		t.Fatalf("scalar/point consistency check failed")
	}
}
