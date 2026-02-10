package ocpcrypto

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type vectorsFile struct {
	Suite        string            `json:"suite"`
	HashToScalar []hashToScalarVec `json:"hashToScalar"`
	ElGamal      []elgamalVec      `json:"elgamal"`
	ChaumPed     []chaumPedVec     `json:"chaumPedersen"`
}

type hashToScalarVec struct {
	Domain      string   `json:"domain"`
	MessagesHex []string `json:"messagesHex"`
	ScalarHexLE string   `json:"scalarHexLE"`
}

type elgamalVec struct {
	SkHexLE    string `json:"skHexLE"`
	PkHex      string `json:"pkHex"`
	MessageHex string `json:"messageHex"`
	RHexLE     string `json:"rHexLE"`
	C1Hex      string `json:"c1Hex"`
	C2Hex      string `json:"c2Hex"`
}

type chaumPedVec struct {
	YHex     string `json:"yHex"`
	C1Hex    string `json:"c1Hex"`
	DHex     string `json:"dHex"`
	ProofHex string `json:"proofHex"`
}

func loadVectors(t *testing.T) vectorsFile {
	t.Helper()
	path := filepath.Join("testdata", "ocp-crypto-v1.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vf vectorsFile
	if err := json.Unmarshal(b, &vf); err != nil {
		t.Fatalf("decode vectors: %v", err)
	}
	return vf
}

func mustHex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hexToBytes(s)
	if err != nil {
		t.Fatalf("hexToBytes(%q): %v", s, err)
	}
	return b
}

func TestVectors_HashToScalar(t *testing.T) {
	vf := loadVectors(t)
	for i, v := range vf.HashToScalar {
		msgs := make([][]byte, 0, len(v.MessagesHex))
		for _, mh := range v.MessagesHex {
			msgs = append(msgs, mustHex(t, mh))
		}
		got, err := HashToScalar(v.Domain, msgs...)
		if err != nil {
			t.Fatalf("hashToScalar vec[%d]: %v", i, err)
		}
		want := mustHex(t, v.ScalarHexLE)
		if !bytes.Equal(got.Bytes(), want) {
			t.Fatalf("hashToScalar vec[%d] mismatch: got=%s want=%s", i, bytesToHex(got.Bytes()), bytesToHex(want))
		}
	}
}

func TestVectors_ElGamal(t *testing.T) {
	vf := loadVectors(t)
	for i, v := range vf.ElGamal {
		sk, err := ScalarFromBytesCanonical(mustHex(t, v.SkHexLE))
		if err != nil {
			t.Fatalf("elgamal vec[%d] sk: %v", i, err)
		}
		pk, err := PointFromBytesCanonical(mustHex(t, v.PkHex))
		if err != nil {
			t.Fatalf("elgamal vec[%d] pk: %v", i, err)
		}
		msg, err := PointFromBytesCanonical(mustHex(t, v.MessageHex))
		if err != nil {
			t.Fatalf("elgamal vec[%d] message: %v", i, err)
		}
		r, err := ScalarFromBytesCanonical(mustHex(t, v.RHexLE))
		if err != nil {
			t.Fatalf("elgamal vec[%d] r: %v", i, err)
		}
		wantC1, err := PointFromBytesCanonical(mustHex(t, v.C1Hex))
		if err != nil {
			t.Fatalf("elgamal vec[%d] c1: %v", i, err)
		}
		wantC2, err := PointFromBytesCanonical(mustHex(t, v.C2Hex))
		if err != nil {
			t.Fatalf("elgamal vec[%d] c2: %v", i, err)
		}

		// pk should be sk*G
		gotPK := MulBase(sk)
		if !PointEq(gotPK, pk) {
			t.Fatalf("elgamal vec[%d] pk mismatch", i)
		}

		ct, err := ElGamalEncrypt(pk, msg, r)
		if err != nil {
			t.Fatalf("elgamal vec[%d] encrypt: %v", i, err)
		}
		if !PointEq(ct.C1, wantC1) || !PointEq(ct.C2, wantC2) {
			t.Fatalf("elgamal vec[%d] ciphertext mismatch: got=(%s,%s) want=(%s,%s)",
				i,
				bytesToHex(ct.C1.Bytes()), bytesToHex(ct.C2.Bytes()),
				bytesToHex(wantC1.Bytes()), bytesToHex(wantC2.Bytes()),
			)
		}

		pt := ElGamalDecrypt(sk, ct)
		if !PointEq(pt, msg) {
			t.Fatalf("elgamal vec[%d] decrypt mismatch", i)
		}
	}
}

func TestVectors_ChaumPedersen(t *testing.T) {
	vf := loadVectors(t)
	for i, v := range vf.ChaumPed {
		y, err := PointFromBytesCanonical(mustHex(t, v.YHex))
		if err != nil {
			t.Fatalf("cp vec[%d] y: %v", i, err)
		}
		c1, err := PointFromBytesCanonical(mustHex(t, v.C1Hex))
		if err != nil {
			t.Fatalf("cp vec[%d] c1: %v", i, err)
		}
		d, err := PointFromBytesCanonical(mustHex(t, v.DHex))
		if err != nil {
			t.Fatalf("cp vec[%d] d: %v", i, err)
		}
		proofBytes := mustHex(t, v.ProofHex)
		p, err := DecodeChaumPedersenProof(proofBytes)
		if err != nil {
			t.Fatalf("cp vec[%d] decode: %v", i, err)
		}

		ok, err := ChaumPedersenVerify(y, c1, d, p)
		if err != nil {
			t.Fatalf("cp vec[%d] verify err: %v", i, err)
		}
		if !ok {
			t.Fatalf("cp vec[%d] verify failed", i)
		}
	}
}

func TestEncShareProof_RoundTripAndTamperFails(t *testing.T) {
	x := ScalarFromUint64(5)
	r := ScalarFromUint64(7)
	wx := ScalarFromUint64(11)
	wr := ScalarFromUint64(13)

	Y := MulBase(x)
	C1 := MulBase(ScalarFromUint64(123))
	PKP := MulBase(ScalarFromUint64(9))
	U := MulBase(r)
	V := PointAdd(MulPoint(C1, x), MulPoint(PKP, r))

	p, err := EncShareProve(Y, C1, PKP, U, V, x, r, wx, wr)
	if err != nil {
		t.Fatalf("prove: %v", err)
	}
	ok, err := EncShareVerify(Y, C1, PKP, U, V, p)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if !ok {
		t.Fatalf("expected proof to verify")
	}

	enc := EncodeEncShareProof(p)
	dec, err := DecodeEncShareProof(enc)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	ok, err = EncShareVerify(Y, C1, PKP, U, V, dec)
	if err != nil {
		t.Fatalf("verify(decoded): %v", err)
	}
	if !ok {
		t.Fatalf("expected decoded proof to verify")
	}

	// Tamper one byte.
	enc[0] ^= 0x01
	bad, err := DecodeEncShareProof(enc)
	if err == nil {
		ok, err = EncShareVerify(Y, C1, PKP, U, V, bad)
		if err != nil {
			t.Fatalf("verify(tampered): %v", err)
		}
		if ok {
			t.Fatalf("expected tampered proof to fail")
		}
	}
}

func TestLagrangeAtZero_ReconstructsConstantTerm(t *testing.T) {
	// f(x) = a0 + a1*x + a2*x^2 over the scalar field.
	a0 := ScalarFromUint64(12345)
	a1 := ScalarFromUint64(77)
	a2 := ScalarFromUint64(5)

	eval := func(x uint32) Scalar {
		xs := ScalarFromUint64(uint64(x))
		x2 := ScalarMul(xs, xs)
		return ScalarAdd(a0, ScalarAdd(ScalarMul(a1, xs), ScalarMul(a2, x2)))
	}

	idxs := []uint32{1, 2, 5}
	ls, err := LagrangeAtZero(idxs)
	if err != nil {
		t.Fatalf("lagrange: %v", err)
	}
	if len(ls) != len(idxs) {
		t.Fatalf("lambda len mismatch")
	}

	got := ScalarFromUint64(0)
	for i, idx := range idxs {
		got = ScalarAdd(got, ScalarMul(ls[i], eval(idx)))
	}
	if !bytes.Equal(got.Bytes(), a0.Bytes()) {
		t.Fatalf("reconstruction mismatch: got=%s want=%s", bytesToHex(got.Bytes()), bytesToHex(a0.Bytes()))
	}
}
