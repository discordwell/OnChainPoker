package ocpcrypto

import (
	"fmt"

	"github.com/gtank/ristretto255"
)

const PointBytes = 32

// Point is a ristretto255 group element (canonical 32-byte encoding).
type Point struct {
	v ristretto255.Element
}

func PointZero() Point {
	var p Point
	p.v.Zero()
	return p
}

func PointBase() Point {
	var p Point
	p.v.Base()
	return p
}

func PointFromBytesCanonical(b []byte) (Point, error) {
	if len(b) != PointBytes {
		return Point{}, fmt.Errorf("point: expected %d bytes", PointBytes)
	}
	var p Point
	if _, err := p.v.SetCanonicalBytes(b); err != nil {
		return Point{}, fmt.Errorf("point: non-canonical: %w", err)
	}
	return p, nil
}

func (p Point) Bytes() []byte {
	return p.v.Bytes()
}

func PointEq(a, b Point) bool {
	return a.v.Equal(&b.v) == 1
}

func PointAdd(a, b Point) Point {
	var out Point
	out.v.Add(&a.v, &b.v)
	return out
}

func PointSub(a, b Point) Point {
	var out Point
	out.v.Subtract(&a.v, &b.v)
	return out
}

func MulBase(k Scalar) Point {
	var out Point
	out.v.ScalarBaseMult(&k.v)
	return out
}

func MulPoint(p Point, k Scalar) Point {
	var out Point
	out.v.ScalarMult(&k.v, &p.v)
	return out
}

