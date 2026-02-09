package ocpcrypto

import (
	"fmt"

	"github.com/gtank/ristretto255"
)

const ScalarBytes = 32

// Scalar is a ristretto255 scalar (canonical 32-byte little-endian encoding).
type Scalar struct {
	v ristretto255.Scalar
}

func ScalarZero() Scalar {
	return Scalar{}
}

func ScalarFromUint64(x uint64) Scalar {
	// ristretto255.Scalar expects canonical little-endian encoding.
	var b [32]byte
	for i := 0; i < 8; i++ {
		b[i] = byte(x >> (8 * i))
	}
	var s Scalar
	_, err := s.v.SetCanonicalBytes(b[:])
	if err == nil {
		return s
	}
	// For x >= l (shouldn't happen for uint64), reduce via uniform bytes.
	var uni [64]byte
	copy(uni[:], b[:])
	s.v.FromUniformBytes(uni[:])
	return s
}

func ScalarFromBytesCanonical(b []byte) (Scalar, error) {
	if len(b) != ScalarBytes {
		return Scalar{}, fmt.Errorf("scalar: expected %d bytes", ScalarBytes)
	}
	var s Scalar
	if _, err := s.v.SetCanonicalBytes(b); err != nil {
		return Scalar{}, fmt.Errorf("scalar: non-canonical: %w", err)
	}
	return s, nil
}

func ScalarFromUniformBytes(b []byte) (Scalar, error) {
	if len(b) != 64 {
		return Scalar{}, fmt.Errorf("scalar: expected 64 uniform bytes")
	}
	var s Scalar
	s.v.FromUniformBytes(b)
	return s, nil
}

func (s Scalar) Bytes() []byte {
	return s.v.Bytes()
}

func (s Scalar) IsZero() bool {
	var z ristretto255.Scalar
	return s.v.Equal(&z) == 1
}

func ScalarAdd(a, b Scalar) Scalar {
	var out Scalar
	out.v.Add(&a.v, &b.v)
	return out
}

func ScalarSub(a, b Scalar) Scalar {
	var out Scalar
	out.v.Subtract(&a.v, &b.v)
	return out
}

func ScalarMul(a, b Scalar) Scalar {
	var out Scalar
	out.v.Multiply(&a.v, &b.v)
	return out
}

func ScalarNeg(a Scalar) Scalar {
	var out Scalar
	out.v.Negate(&a.v)
	return out
}

func ScalarInv(a Scalar) (Scalar, error) {
	if a.IsZero() {
		return Scalar{}, fmt.Errorf("scalar: inverse of zero")
	}
	var out Scalar
	out.v.Invert(&a.v)
	return out, nil
}

