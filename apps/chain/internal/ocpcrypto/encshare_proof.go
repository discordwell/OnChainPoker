package ocpcrypto

import "fmt"

// EncShareProof is a Schnorr-style proof of knowledge for the statement:
//
// There exist scalars (x, r) such that:
//   Y = x*G
//   U = r*G
//   V = x*C1 + r*PKP
//
// where (U,V) is an ElGamal encryption (under PKP) of the decryption share x*C1.
type EncShareProof struct {
	A1 Point  // w_x*G
	A2 Point  // w_r*G
	A3 Point  // w_x*C1 + w_r*PKP
	SX Scalar // w_x + e*x
	SR Scalar // w_r + e*r
}

const encShareDomain = "ocp/v1/dealer/encshare"

func EncShareProve(Y Point, C1 Point, PKP Point, U Point, V Point, x Scalar, r Scalar, wx Scalar, wr Scalar) (EncShareProof, error) {
	if wx.IsZero() || wr.IsZero() {
		return EncShareProof{}, fmt.Errorf("encshare: nonces must be non-zero")
	}
	a1 := MulBase(wx)
	a2 := MulBase(wr)
	a3 := PointAdd(MulPoint(C1, wx), MulPoint(PKP, wr))

	tr := NewTranscript(encShareDomain)
	_ = tr.AppendMessage("Y", Y.Bytes())
	_ = tr.AppendMessage("C1", C1.Bytes())
	_ = tr.AppendMessage("PKP", PKP.Bytes())
	_ = tr.AppendMessage("U", U.Bytes())
	_ = tr.AppendMessage("V", V.Bytes())
	_ = tr.AppendMessage("A1", a1.Bytes())
	_ = tr.AppendMessage("A2", a2.Bytes())
	_ = tr.AppendMessage("A3", a3.Bytes())
	e, err := tr.ChallengeScalar("e")
	if err != nil {
		return EncShareProof{}, err
	}

	sx := ScalarAdd(wx, ScalarMul(e, x))
	sr := ScalarAdd(wr, ScalarMul(e, r))
	return EncShareProof{A1: a1, A2: a2, A3: a3, SX: sx, SR: sr}, nil
}

func EncShareVerify(Y Point, C1 Point, PKP Point, U Point, V Point, proof EncShareProof) (bool, error) {
	tr := NewTranscript(encShareDomain)
	_ = tr.AppendMessage("Y", Y.Bytes())
	_ = tr.AppendMessage("C1", C1.Bytes())
	_ = tr.AppendMessage("PKP", PKP.Bytes())
	_ = tr.AppendMessage("U", U.Bytes())
	_ = tr.AppendMessage("V", V.Bytes())
	_ = tr.AppendMessage("A1", proof.A1.Bytes())
	_ = tr.AppendMessage("A2", proof.A2.Bytes())
	_ = tr.AppendMessage("A3", proof.A3.Bytes())
	e, err := tr.ChallengeScalar("e")
	if err != nil {
		return false, err
	}

	// Check: sx*G == A1 + e*Y
	lhs1 := MulBase(proof.SX)
	rhs1 := PointAdd(proof.A1, MulPoint(Y, e))
	if !PointEq(lhs1, rhs1) {
		return false, nil
	}

	// Check: sr*G == A2 + e*U
	lhs2 := MulBase(proof.SR)
	rhs2 := PointAdd(proof.A2, MulPoint(U, e))
	if !PointEq(lhs2, rhs2) {
		return false, nil
	}

	// Check: sx*C1 + sr*PKP == A3 + e*V
	lhs3 := PointAdd(MulPoint(C1, proof.SX), MulPoint(PKP, proof.SR))
	rhs3 := PointAdd(proof.A3, MulPoint(V, e))
	if !PointEq(lhs3, rhs3) {
		return false, nil
	}

	return true, nil
}

// Encoding: A1(32)||A2(32)||A3(32)||sx(32)||sr(32) = 160 bytes.
func EncodeEncShareProof(p EncShareProof) []byte {
	return concatBytes(p.A1.Bytes(), p.A2.Bytes(), p.A3.Bytes(), p.SX.Bytes(), p.SR.Bytes())
}

func DecodeEncShareProof(b []byte) (EncShareProof, error) {
	if len(b) != 160 {
		return EncShareProof{}, fmt.Errorf("encshare: expected 160 bytes")
	}
	a1, err := PointFromBytesCanonical(b[0:32])
	if err != nil {
		return EncShareProof{}, err
	}
	a2, err := PointFromBytesCanonical(b[32:64])
	if err != nil {
		return EncShareProof{}, err
	}
	a3, err := PointFromBytesCanonical(b[64:96])
	if err != nil {
		return EncShareProof{}, err
	}
	sx, err := ScalarFromBytesCanonical(b[96:128])
	if err != nil {
		return EncShareProof{}, err
	}
	sr, err := ScalarFromBytesCanonical(b[128:160])
	if err != nil {
		return EncShareProof{}, err
	}
	return EncShareProof{A1: a1, A2: a2, A3: a3, SX: sx, SR: sr}, nil
}

