package ocpcrypto

import "fmt"

type ChaumPedersenProof struct {
	// a = w*G
	A Point
	// b = w*c1
	B Point
	// s = w + e*x
	S Scalar
}

const chaumPedersenDomain = "ocp/v1/chaum-pedersen-eqdl"

func ChaumPedersenProve(y Point, c1 Point, d Point, x Scalar, w Scalar) (ChaumPedersenProof, error) {
	if x.IsZero() {
		// witness x=0 is allowed; keep this for parity with TS which only checks scalar range.
	}
	if w.IsZero() {
		return ChaumPedersenProof{}, fmt.Errorf("chaum-pedersen: w must be non-zero")
	}

	a := MulBase(w)
	b := MulPoint(c1, w)

	tr := NewTranscript(chaumPedersenDomain)
	_ = tr.AppendMessage("y", y.Bytes())
	_ = tr.AppendMessage("c1", c1.Bytes())
	_ = tr.AppendMessage("d", d.Bytes())
	_ = tr.AppendMessage("a", a.Bytes())
	_ = tr.AppendMessage("b", b.Bytes())
	e, err := tr.ChallengeScalar("e")
	if err != nil {
		return ChaumPedersenProof{}, err
	}

	s := ScalarAdd(w, ScalarMul(e, x))
	return ChaumPedersenProof{A: a, B: b, S: s}, nil
}

func ChaumPedersenVerify(y Point, c1 Point, d Point, proof ChaumPedersenProof) (bool, error) {
	tr := NewTranscript(chaumPedersenDomain)
	_ = tr.AppendMessage("y", y.Bytes())
	_ = tr.AppendMessage("c1", c1.Bytes())
	_ = tr.AppendMessage("d", d.Bytes())
	_ = tr.AppendMessage("a", proof.A.Bytes())
	_ = tr.AppendMessage("b", proof.B.Bytes())
	e, err := tr.ChallengeScalar("e")
	if err != nil {
		return false, err
	}

	// Check: s*G == a + e*y
	lhs1 := MulBase(proof.S)
	rhs1 := PointAdd(proof.A, MulPoint(y, e))
	if !PointEq(lhs1, rhs1) {
		return false, nil
	}

	// Check: s*c1 == b + e*d
	lhs2 := MulPoint(c1, proof.S)
	rhs2 := PointAdd(proof.B, MulPoint(d, e))
	if !PointEq(lhs2, rhs2) {
		return false, nil
	}
	return true, nil
}

// Encoding: A(32) || B(32) || s(32 le)
func EncodeChaumPedersenProof(p ChaumPedersenProof) []byte {
	return concatBytes(p.A.Bytes(), p.B.Bytes(), p.S.Bytes())
}

func DecodeChaumPedersenProof(b []byte) (ChaumPedersenProof, error) {
	if len(b) != 96 {
		return ChaumPedersenProof{}, fmt.Errorf("chaum-pedersen: expected 96 bytes")
	}
	a, err := PointFromBytesCanonical(b[0:32])
	if err != nil {
		return ChaumPedersenProof{}, err
	}
	bl, err := PointFromBytesCanonical(b[32:64])
	if err != nil {
		return ChaumPedersenProof{}, err
	}
	s, err := ScalarFromBytesCanonical(b[64:96])
	if err != nil {
		return ChaumPedersenProof{}, err
	}
	return ChaumPedersenProof{A: a, B: bl, S: s}, nil
}

