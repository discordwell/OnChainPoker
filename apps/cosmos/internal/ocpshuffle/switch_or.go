package ocpshuffle

import (
	"onchainpoker/apps/cosmos/internal/ocpcrypto"
)

type SwitchProof struct {
	// Challenge for branch 0 (no swap). Branch 1 is derived as e - e0.
	E0 ocpcrypto.Scalar
	// 4 relations, each with commitments (t1,t2) and response z.
	// Ordering matches docs/SHUFFLE.md:
	//  0: branch0 rel0 (out0 vs in0)
	//  1: branch0 rel1 (out1 vs in1)
	//  2: branch1 rel0 (out0 vs in1)
	//  3: branch1 rel1 (out1 vs in0)
	T1 [4]ocpcrypto.Point
	T2 [4]ocpcrypto.Point
	Z  [4]ocpcrypto.Scalar
}

const (
	domainSwitch = "ocp/v1/shuffle/switch-or"
)

var G = ocpcrypto.PointBase()
var switchChallengeT1Labels = [4]string{"t1.0", "t1.1", "t1.2", "t1.3"}
var switchChallengeT2Labels = [4]string{"t2.0", "t2.1", "t2.2", "t2.3"}

func dlogDiff(inCt ocpcrypto.ElGamalCiphertext, outCt ocpcrypto.ElGamalCiphertext) (ocpcrypto.Point, ocpcrypto.Point) {
	// X = out.c1 - in.c1 = rho*G
	// Y = out.c2 - in.c2 = rho*pk
	X := ocpcrypto.PointSub(outCt.C1, inCt.C1)
	Y := ocpcrypto.PointSub(outCt.C2, inCt.C2)
	return X, Y
}

func switchChallenge(pk ocpcrypto.Point, in0 ocpcrypto.ElGamalCiphertext, in1 ocpcrypto.ElGamalCiphertext, out0 ocpcrypto.ElGamalCiphertext, out1 ocpcrypto.ElGamalCiphertext, t1 [4]ocpcrypto.Point, t2 [4]ocpcrypto.Point) (ocpcrypto.Scalar, error) {
	tr := ocpcrypto.NewTranscript(domainSwitch)
	_ = tr.AppendMessage("pk", pk.Bytes())
	_ = tr.AppendMessage("in0.c1", in0.C1.Bytes())
	_ = tr.AppendMessage("in0.c2", in0.C2.Bytes())
	_ = tr.AppendMessage("in1.c1", in1.C1.Bytes())
	_ = tr.AppendMessage("in1.c2", in1.C2.Bytes())
	_ = tr.AppendMessage("out0.c1", out0.C1.Bytes())
	_ = tr.AppendMessage("out0.c2", out0.C2.Bytes())
	_ = tr.AppendMessage("out1.c1", out1.C1.Bytes())
	_ = tr.AppendMessage("out1.c2", out1.C2.Bytes())
	for i := 0; i < 4; i++ {
		_ = tr.AppendMessage(switchChallengeT1Labels[i], t1[i].Bytes())
	}
	for i := 0; i < 4; i++ {
		_ = tr.AppendMessage(switchChallengeT2Labels[i], t2[i].Bytes())
	}
	return tr.ChallengeScalar("e")
}

func proveSwitch(pk ocpcrypto.Point, in0 ocpcrypto.ElGamalCiphertext, in1 ocpcrypto.ElGamalCiphertext, out0 ocpcrypto.ElGamalCiphertext, out1 ocpcrypto.ElGamalCiphertext, swapped bool, rho0 ocpcrypto.Scalar, rho1 ocpcrypto.Scalar, rng scalarRng) (SwitchProof, error) {
	// Public relations:
	// branch0:
	//  rel0: out0 vs in0
	//  rel1: out1 vs in1
	// branch1:
	//  rel0: out0 vs in1
	//  rel1: out1 vs in0
	relIn := [4]ocpcrypto.ElGamalCiphertext{in0, in1, in1, in0}
	relOut := [4]ocpcrypto.ElGamalCiphertext{out0, out1, out0, out1}

	trueBranch := 0
	if swapped {
		trueBranch = 1
	}
	simBranch := 1 - trueBranch

	eSim, err := rng.NextScalar()
	if err != nil {
		return SwitchProof{}, err
	}

	var t1 [4]ocpcrypto.Point
	var t2 [4]ocpcrypto.Point
	var z [4]ocpcrypto.Scalar

	// Simulated branch (2 relations).
	var simIdxs [2]int
	if simBranch == 0 {
		simIdxs = [2]int{0, 1}
	} else {
		simIdxs = [2]int{2, 3}
	}
	for _, idx := range simIdxs {
		X, Y := dlogDiff(relIn[idx], relOut[idx])
		zSim, err := rng.NextScalar()
		if err != nil {
			return SwitchProof{}, err
		}
		z[idx] = zSim
		tt1, tt2 := simulateEqDlogCommitments(G, pk, X, Y, eSim, zSim)
		t1[idx] = tt1
		t2[idx] = tt2
	}

	// Real branch commitments (2 relations) with random nonces.
	w0, err := rng.NextScalar()
	if err != nil {
		return SwitchProof{}, err
	}
	w1, err := rng.NextScalar()
	if err != nil {
		return SwitchProof{}, err
	}
	var realIdxs [2]int
	if trueBranch == 0 {
		realIdxs = [2]int{0, 1}
	} else {
		realIdxs = [2]int{2, 3}
	}
	t1[realIdxs[0]] = ocpcrypto.MulPoint(G, w0)
	t2[realIdxs[0]] = ocpcrypto.MulPoint(pk, w0)
	t1[realIdxs[1]] = ocpcrypto.MulPoint(G, w1)
	t2[realIdxs[1]] = ocpcrypto.MulPoint(pk, w1)

	e, err := switchChallenge(pk, in0, in1, out0, out1, t1, t2)
	if err != nil {
		return SwitchProof{}, err
	}

	var e0 ocpcrypto.Scalar
	var e1 ocpcrypto.Scalar
	if trueBranch == 0 {
		e1 = eSim
		e0 = ocpcrypto.ScalarSub(e, e1)
		z[0] = ocpcrypto.ScalarAdd(w0, ocpcrypto.ScalarMul(e0, rho0))
		z[1] = ocpcrypto.ScalarAdd(w1, ocpcrypto.ScalarMul(e0, rho1))
	} else {
		e0 = eSim
		e1 = ocpcrypto.ScalarSub(e, e0)
		z[2] = ocpcrypto.ScalarAdd(w0, ocpcrypto.ScalarMul(e1, rho0))
		z[3] = ocpcrypto.ScalarAdd(w1, ocpcrypto.ScalarMul(e1, rho1))
	}

	return SwitchProof{E0: e0, T1: t1, T2: t2, Z: z}, nil
}

func verifySwitch(pk ocpcrypto.Point, in0 ocpcrypto.ElGamalCiphertext, in1 ocpcrypto.ElGamalCiphertext, out0 ocpcrypto.ElGamalCiphertext, out1 ocpcrypto.ElGamalCiphertext, proof SwitchProof) (bool, error) {
	// Enforce non-zero re-randomization: output c1 must not reuse either input c1 verbatim.
	if ocpcrypto.PointEq(out0.C1, in0.C1) || ocpcrypto.PointEq(out0.C1, in1.C1) {
		return false, nil
	}
	if ocpcrypto.PointEq(out1.C1, in0.C1) || ocpcrypto.PointEq(out1.C1, in1.C1) {
		return false, nil
	}

	e, err := switchChallenge(pk, in0, in1, out0, out1, proof.T1, proof.T2)
	if err != nil {
		return false, err
	}
	e1 := ocpcrypto.ScalarSub(e, proof.E0)

	{
		z := proof.Z[0]
		X, Y := dlogDiff(in0, out0)
		lhs1 := ocpcrypto.MulPoint(G, z)
		rhs1 := ocpcrypto.PointAdd(proof.T1[0], ocpcrypto.MulPoint(X, proof.E0))
		if !ocpcrypto.PointEq(lhs1, rhs1) {
			return false, nil
		}

		lhs2 := ocpcrypto.MulPoint(pk, z)
		rhs2 := ocpcrypto.PointAdd(proof.T2[0], ocpcrypto.MulPoint(Y, proof.E0))
		if !ocpcrypto.PointEq(lhs2, rhs2) {
			return false, nil
		}
	}

	{
		z := proof.Z[1]
		X, Y := dlogDiff(in1, out1)
		lhs1 := ocpcrypto.MulPoint(G, z)
		rhs1 := ocpcrypto.PointAdd(proof.T1[1], ocpcrypto.MulPoint(X, proof.E0))
		if !ocpcrypto.PointEq(lhs1, rhs1) {
			return false, nil
		}

		lhs2 := ocpcrypto.MulPoint(pk, z)
		rhs2 := ocpcrypto.PointAdd(proof.T2[1], ocpcrypto.MulPoint(Y, proof.E0))
		if !ocpcrypto.PointEq(lhs2, rhs2) {
			return false, nil
		}
	}

	{
		z := proof.Z[2]
		X, Y := dlogDiff(in1, out0)
		lhs1 := ocpcrypto.MulPoint(G, z)
		rhs1 := ocpcrypto.PointAdd(proof.T1[2], ocpcrypto.MulPoint(X, e1))
		if !ocpcrypto.PointEq(lhs1, rhs1) {
			return false, nil
		}

		lhs2 := ocpcrypto.MulPoint(pk, z)
		rhs2 := ocpcrypto.PointAdd(proof.T2[2], ocpcrypto.MulPoint(Y, e1))
		if !ocpcrypto.PointEq(lhs2, rhs2) {
			return false, nil
		}
	}

	{
		z := proof.Z[3]
		X, Y := dlogDiff(in0, out1)
		lhs1 := ocpcrypto.MulPoint(G, z)
		rhs1 := ocpcrypto.PointAdd(proof.T1[3], ocpcrypto.MulPoint(X, e1))
		if !ocpcrypto.PointEq(lhs1, rhs1) {
			return false, nil
		}

		lhs2 := ocpcrypto.MulPoint(pk, z)
		rhs2 := ocpcrypto.PointAdd(proof.T2[3], ocpcrypto.MulPoint(Y, e1))
		if !ocpcrypto.PointEq(lhs2, rhs2) {
			return false, nil
		}
	}

	return true, nil
}

// Encoding: e0(32) || 4*(t1(32) || t2(32) || z(32))
func encodeSwitchProof(p SwitchProof) []byte {
	chunks := make([][]byte, 0, 1+4*3)
	chunks = append(chunks, encodeScalar(p.E0))
	for i := 0; i < 4; i++ {
		chunks = append(chunks, encodePoint(p.T1[i]))
		chunks = append(chunks, encodePoint(p.T2[i]))
		chunks = append(chunks, encodeScalar(p.Z[i]))
	}
	out := make([]byte, 0, 32+4*96)
	for _, c := range chunks {
		out = append(out, c...)
	}
	return out
}

func decodeSwitchProofFromReader(r *reader) (SwitchProof, error) {
	e0b, err := r.take(32)
	if err != nil {
		return SwitchProof{}, err
	}
	e0, err := decodeScalar(e0b)
	if err != nil {
		return SwitchProof{}, err
	}
	var t1 [4]ocpcrypto.Point
	var t2 [4]ocpcrypto.Point
	var z [4]ocpcrypto.Scalar
	for i := 0; i < 4; i++ {
		t1b, err := r.take(32)
		if err != nil {
			return SwitchProof{}, err
		}
		t2b, err := r.take(32)
		if err != nil {
			return SwitchProof{}, err
		}
		zb, err := r.take(32)
		if err != nil {
			return SwitchProof{}, err
		}
		t1i, err := decodePoint(t1b)
		if err != nil {
			return SwitchProof{}, err
		}
		t2i, err := decodePoint(t2b)
		if err != nil {
			return SwitchProof{}, err
		}
		zi, err := decodeScalar(zb)
		if err != nil {
			return SwitchProof{}, err
		}
		t1[i] = t1i
		t2[i] = t2i
		z[i] = zi
	}
	return SwitchProof{E0: e0, T1: t1, T2: t2, Z: z}, nil
}
