package ocpcrypto

import "fmt"

type ElGamalCiphertext struct {
	C1 Point
	C2 Point
}

// ElGamal in additive notation:
//   PK = Y = x*G
//   Enc(Y, M; r) = (r*G, M + r*Y)
func ElGamalEncrypt(pk Point, m Point, r Scalar) (ElGamalCiphertext, error) {
	if r.IsZero() {
		// Zero randomness is valid mathematically but leaks the plaintext.
		return ElGamalCiphertext{}, fmt.Errorf("elgamal: r must be non-zero")
	}
	c1 := MulBase(r)
	c2 := PointAdd(m, MulPoint(pk, r))
	return ElGamalCiphertext{C1: c1, C2: c2}, nil
}

// Dec(x, (c1,c2)) = c2 - x*c1
func ElGamalDecrypt(sk Scalar, ct ElGamalCiphertext) Point {
	return PointSub(ct.C2, MulPoint(ct.C1, sk))
}

