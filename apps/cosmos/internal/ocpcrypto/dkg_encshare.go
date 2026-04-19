package ocpcrypto

import "fmt"

// DkgEncShareProof is a Sigma / Schnorr-style NIZK for the statement that an
// on-chain ciphertext (U, V) carries a Feldman-consistent DKG share to
// recipient j, encrypted under that recipient's per-epoch public key pkR.
// Specifically, the prover knows scalars (s, r) with:
//
//	(a) s*G = Σ_{k=0..t-1} C_k * j^k   (share is consistent with commitments)
//	(b) U   = r*G                       (ElGamal ephemeral)
//	(c) V   = s*G + r*pkR               (ElGamal on the share point)
//
// Fiat-Shamir transformed using Transcript with domain "ocp/v1/dkg/encshare".
// Wire format is fixed 160 bytes: A1||A2||A3||ss||sr (each 32 LE). This layout
// and the transcript order MUST match packages/ocp-crypto/src/proofs/dkgEncShare.ts
// byte-for-byte — the primitive is a cross-language verification contract.
type DkgEncShareProof struct {
	A1 Point  // ws*G
	A2 Point  // wr*G
	A3 Point  // ws*G + wr*pkR
	SS Scalar // ws + e*s
	SR Scalar // wr + e*r
}

const dkgEncShareDomain = "ocp/v1/dkg/encshare"

// DkgEncShareProofBytes is the fixed wire size of an encoded proof.
const DkgEncShareProofBytes = 160

// EvalCommitments computes Σ_{k=0..t-1} C_k * j^k (the expected share point
// at recipient index j per the dealer's Feldman commitments). j == 0 is
// disallowed by Feldman VSS — it would directly leak C_0 as the share point.
func EvalCommitments(commitments []Point, j uint32) (Point, error) {
	if len(commitments) == 0 {
		return Point{}, fmt.Errorf("dkgEncShare: commitments must be non-empty")
	}
	if j == 0 {
		return Point{}, fmt.Errorf("dkgEncShare: j must be >= 1")
	}
	jScalar := ScalarFromUint64(uint64(j))
	pow := ScalarFromUint64(1)
	acc := PointZero()
	for _, c := range commitments {
		acc = PointAdd(acc, MulPoint(c, pow))
		pow = ScalarMul(pow, jScalar)
	}
	return acc, nil
}

// appendDkgEncShareStatement binds all public inputs to the transcript in
// the same order (and with the same labels) as the TS implementation. The
// threshold `t` is bound as a u32le length prefix on the commitments label
// to foreclose truncate/pad attacks on the commitments vector.
func appendDkgEncShareStatement(tr *Transcript, commitments []Point, j uint32, pkR, u, v Point) error {
	if err := tr.AppendMessage("t", u32le(uint32(len(commitments)))); err != nil {
		return err
	}
	for k, c := range commitments {
		if err := tr.AppendMessage(fmt.Sprintf("C%d", k), c.Bytes()); err != nil {
			return err
		}
	}
	if err := tr.AppendMessage("j", u32le(j)); err != nil {
		return err
	}
	if err := tr.AppendMessage("pkR", pkR.Bytes()); err != nil {
		return err
	}
	if err := tr.AppendMessage("U", u.Bytes()); err != nil {
		return err
	}
	if err := tr.AppendMessage("V", v.Bytes()); err != nil {
		return err
	}
	return nil
}

// DkgEncShareProve produces a NIZK proof for the statement described on
// DkgEncShareProof. Nonces (ws, wr) must be freshly sampled, non-zero,
// canonical scalars. The caller is responsible for supplying valid (U, V)
// and the matching (s, r) witness.
func DkgEncShareProve(commitments []Point, j uint32, pkR, u, v Point, s, r, ws, wr Scalar) (DkgEncShareProof, error) {
	if len(commitments) == 0 {
		return DkgEncShareProof{}, fmt.Errorf("dkgEncShare: commitments must be non-empty")
	}
	if j == 0 {
		return DkgEncShareProof{}, fmt.Errorf("dkgEncShare: j must be >= 1")
	}
	if ws.IsZero() || wr.IsZero() {
		return DkgEncShareProof{}, fmt.Errorf("dkgEncShare: nonces must be non-zero")
	}

	a1 := MulBase(ws)
	a2 := MulBase(wr)
	a3 := PointAdd(MulBase(ws), MulPoint(pkR, wr))

	tr := NewTranscript(dkgEncShareDomain)
	if err := appendDkgEncShareStatement(tr, commitments, j, pkR, u, v); err != nil {
		return DkgEncShareProof{}, err
	}
	if err := tr.AppendMessage("A1", a1.Bytes()); err != nil {
		return DkgEncShareProof{}, err
	}
	if err := tr.AppendMessage("A2", a2.Bytes()); err != nil {
		return DkgEncShareProof{}, err
	}
	if err := tr.AppendMessage("A3", a3.Bytes()); err != nil {
		return DkgEncShareProof{}, err
	}
	e, err := tr.ChallengeScalar("e")
	if err != nil {
		return DkgEncShareProof{}, err
	}

	ss := ScalarAdd(ws, ScalarMul(e, s))
	sr := ScalarAdd(wr, ScalarMul(e, r))
	return DkgEncShareProof{A1: a1, A2: a2, A3: a3, SS: ss, SR: sr}, nil
}

// DkgEncShareVerify checks a proof against the public statement. Returns
// (true, nil) only when all three Sigma-protocol checks pass; (false, nil)
// on any verification failure; (false, err) on malformed inputs that the
// verifier cannot even form a transcript from.
func DkgEncShareVerify(commitments []Point, j uint32, pkR, u, v Point, proof DkgEncShareProof) (bool, error) {
	if len(commitments) == 0 {
		return false, nil
	}
	if j == 0 {
		return false, nil
	}

	evalJ, err := EvalCommitments(commitments, j)
	if err != nil {
		return false, nil
	}

	tr := NewTranscript(dkgEncShareDomain)
	if err := appendDkgEncShareStatement(tr, commitments, j, pkR, u, v); err != nil {
		return false, err
	}
	if err := tr.AppendMessage("A1", proof.A1.Bytes()); err != nil {
		return false, err
	}
	if err := tr.AppendMessage("A2", proof.A2.Bytes()); err != nil {
		return false, err
	}
	if err := tr.AppendMessage("A3", proof.A3.Bytes()); err != nil {
		return false, err
	}
	e, err := tr.ChallengeScalar("e")
	if err != nil {
		return false, err
	}

	// (a) ss*G == A1 + e * Eval_j
	lhs1 := MulBase(proof.SS)
	rhs1 := PointAdd(proof.A1, MulPoint(evalJ, e))
	if !PointEq(lhs1, rhs1) {
		return false, nil
	}

	// (b) sr*G == A2 + e * U
	lhs2 := MulBase(proof.SR)
	rhs2 := PointAdd(proof.A2, MulPoint(u, e))
	if !PointEq(lhs2, rhs2) {
		return false, nil
	}

	// (c) ss*G + sr*pkR == A3 + e * V
	lhs3 := PointAdd(MulBase(proof.SS), MulPoint(pkR, proof.SR))
	rhs3 := PointAdd(proof.A3, MulPoint(v, e))
	if !PointEq(lhs3, rhs3) {
		return false, nil
	}

	return true, nil
}

// EncodeDkgEncShareProof serializes to the canonical 160-byte layout:
//
//	A1(32) || A2(32) || A3(32) || ss(32 LE) || sr(32 LE)
func EncodeDkgEncShareProof(p DkgEncShareProof) []byte {
	return concatBytes(p.A1.Bytes(), p.A2.Bytes(), p.A3.Bytes(), p.SS.Bytes(), p.SR.Bytes())
}

// DecodeDkgEncShareProof parses the canonical 160-byte encoding. Both points
// and scalars are decoded strictly (canonical encodings only) so that
// Encode(Decode(b)) == b round-trips exactly.
func DecodeDkgEncShareProof(b []byte) (DkgEncShareProof, error) {
	if len(b) != DkgEncShareProofBytes {
		return DkgEncShareProof{}, fmt.Errorf("dkgEncShare: expected %d bytes, got %d", DkgEncShareProofBytes, len(b))
	}
	a1, err := PointFromBytesCanonical(b[0:32])
	if err != nil {
		return DkgEncShareProof{}, err
	}
	a2, err := PointFromBytesCanonical(b[32:64])
	if err != nil {
		return DkgEncShareProof{}, err
	}
	a3, err := PointFromBytesCanonical(b[64:96])
	if err != nil {
		return DkgEncShareProof{}, err
	}
	ss, err := ScalarFromBytesCanonical(b[96:128])
	if err != nil {
		return DkgEncShareProof{}, err
	}
	sr, err := ScalarFromBytesCanonical(b[128:160])
	if err != nil {
		return DkgEncShareProof{}, err
	}
	return DkgEncShareProof{A1: a1, A2: a2, A3: a3, SS: ss, SR: sr}, nil
}
