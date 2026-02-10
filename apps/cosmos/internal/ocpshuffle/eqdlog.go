package ocpshuffle

import (
	"fmt"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
)

type EqDlogProof struct {
	T1 ocpcrypto.Point
	T2 ocpcrypto.Point
	Z  ocpcrypto.Scalar
}

// Prove knowledge of x such that:
//   X = x*A and Y = x*B
func proveEqDlog(domain string, A ocpcrypto.Point, B ocpcrypto.Point, X ocpcrypto.Point, Y ocpcrypto.Point, x ocpcrypto.Scalar, rng scalarRng) (EqDlogProof, error) {
	w, err := rng.NextScalar()
	if err != nil {
		return EqDlogProof{}, err
	}
	t1 := ocpcrypto.MulPoint(A, w)
	t2 := ocpcrypto.MulPoint(B, w)

	tr := ocpcrypto.NewTranscript(domain)
	_ = tr.AppendMessage("A", A.Bytes())
	_ = tr.AppendMessage("B", B.Bytes())
	_ = tr.AppendMessage("X", X.Bytes())
	_ = tr.AppendMessage("Y", Y.Bytes())
	_ = tr.AppendMessage("t1", t1.Bytes())
	_ = tr.AppendMessage("t2", t2.Bytes())
	e, err := tr.ChallengeScalar("e")
	if err != nil {
		return EqDlogProof{}, err
	}

	z := ocpcrypto.ScalarAdd(w, ocpcrypto.ScalarMul(e, x))
	return EqDlogProof{T1: t1, T2: t2, Z: z}, nil
}

func verifyEqDlog(domain string, A ocpcrypto.Point, B ocpcrypto.Point, X ocpcrypto.Point, Y ocpcrypto.Point, proof EqDlogProof) (bool, error) {
	tr := ocpcrypto.NewTranscript(domain)
	_ = tr.AppendMessage("A", A.Bytes())
	_ = tr.AppendMessage("B", B.Bytes())
	_ = tr.AppendMessage("X", X.Bytes())
	_ = tr.AppendMessage("Y", Y.Bytes())
	_ = tr.AppendMessage("t1", proof.T1.Bytes())
	_ = tr.AppendMessage("t2", proof.T2.Bytes())
	e, err := tr.ChallengeScalar("e")
	if err != nil {
		return false, err
	}

	// Check: z*A == t1 + e*X
	lhs1 := ocpcrypto.MulPoint(A, proof.Z)
	rhs1 := ocpcrypto.PointAdd(proof.T1, ocpcrypto.MulPoint(X, e))
	if !ocpcrypto.PointEq(lhs1, rhs1) {
		return false, nil
	}

	// Check: z*B == t2 + e*Y
	lhs2 := ocpcrypto.MulPoint(B, proof.Z)
	rhs2 := ocpcrypto.PointAdd(proof.T2, ocpcrypto.MulPoint(Y, e))
	if !ocpcrypto.PointEq(lhs2, rhs2) {
		return false, nil
	}
	return true, nil
}

// Simulation helper: given chosen (e,z), compute commitments that satisfy verification equations.
func simulateEqDlogCommitments(A ocpcrypto.Point, B ocpcrypto.Point, X ocpcrypto.Point, Y ocpcrypto.Point, e ocpcrypto.Scalar, z ocpcrypto.Scalar) (ocpcrypto.Point, ocpcrypto.Point) {
	t1 := ocpcrypto.PointSub(ocpcrypto.MulPoint(A, z), ocpcrypto.MulPoint(X, e))
	t2 := ocpcrypto.PointSub(ocpcrypto.MulPoint(B, z), ocpcrypto.MulPoint(Y, e))
	return t1, t2
}

func encodeEqDlogProof(p EqDlogProof) []byte {
	return append(append(p.T1.Bytes(), p.T2.Bytes()...), p.Z.Bytes()...)
}

func decodeEqDlogProofFromReader(r *reader) (EqDlogProof, error) {
	t1b, err := r.take(32)
	if err != nil {
		return EqDlogProof{}, err
	}
	t2b, err := r.take(32)
	if err != nil {
		return EqDlogProof{}, err
	}
	zb, err := r.take(32)
	if err != nil {
		return EqDlogProof{}, err
	}
	t1, err := decodePoint(t1b)
	if err != nil {
		return EqDlogProof{}, err
	}
	t2, err := decodePoint(t2b)
	if err != nil {
		return EqDlogProof{}, err
	}
	z, err := decodeScalar(zb)
	if err != nil {
		return EqDlogProof{}, err
	}
	return EqDlogProof{T1: t1, T2: t2, Z: z}, nil
}

func decodeEqDlogProof(bytes []byte) (EqDlogProof, error) {
	if len(bytes) != 96 {
		return EqDlogProof{}, fmt.Errorf("decodeEqDlogProof: expected 96 bytes")
	}
	r := newReader(bytes)
	p, err := decodeEqDlogProofFromReader(r)
	if err != nil {
		return EqDlogProof{}, err
	}
	if !r.done() {
		return EqDlogProof{}, fmt.Errorf("decodeEqDlogProof: trailing bytes")
	}
	return p, nil
}

