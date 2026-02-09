package ocpshuffle

import (
	"encoding/binary"
	"fmt"

	"onchainpoker/apps/chain/internal/ocpcrypto"
)

func u16ToBytesLE(x uint16) []byte {
	b := make([]byte, 2)
	binary.LittleEndian.PutUint16(b, x)
	return b
}

func u16FromBytesLE(b []byte) (uint16, error) {
	if len(b) != 2 {
		return 0, fmt.Errorf("u16FromBytesLE: expected 2 bytes")
	}
	return binary.LittleEndian.Uint16(b), nil
}

func encodePoint(p ocpcrypto.Point) []byte {
	return p.Bytes()
}

func decodePoint(b []byte) (ocpcrypto.Point, error) {
	return ocpcrypto.PointFromBytesCanonical(b)
}

func encodeScalar(s ocpcrypto.Scalar) []byte {
	return s.Bytes()
}

func decodeScalar(b []byte) (ocpcrypto.Scalar, error) {
	return ocpcrypto.ScalarFromBytesCanonical(b)
}

func encodeCiphertext(ct ocpcrypto.ElGamalCiphertext) []byte {
	return append(encodePoint(ct.C1), encodePoint(ct.C2)...)
}

func decodeCiphertext(b []byte) (ocpcrypto.ElGamalCiphertext, error) {
	if len(b) != 64 {
		return ocpcrypto.ElGamalCiphertext{}, fmt.Errorf("decodeCiphertext: expected 64 bytes")
	}
	c1, err := decodePoint(b[:32])
	if err != nil {
		return ocpcrypto.ElGamalCiphertext{}, err
	}
	c2, err := decodePoint(b[32:64])
	if err != nil {
		return ocpcrypto.ElGamalCiphertext{}, err
	}
	return ocpcrypto.ElGamalCiphertext{C1: c1, C2: c2}, nil
}

type reader struct {
	bytes []byte
	off   int
}

func newReader(b []byte) *reader {
	return &reader{bytes: b}
}

func (r *reader) take(n int) ([]byte, error) {
	if n < 0 {
		return nil, fmt.Errorf("reader.take: invalid n")
	}
	if r.off+n > len(r.bytes) {
		return nil, fmt.Errorf("reader: out of bounds")
	}
	out := r.bytes[r.off : r.off+n]
	r.off += n
	return out, nil
}

func (r *reader) takeU8() (uint8, error) {
	b, err := r.take(1)
	if err != nil {
		return 0, err
	}
	return b[0], nil
}

func (r *reader) takeU16LE() (uint16, error) {
	b, err := r.take(2)
	if err != nil {
		return 0, err
	}
	return u16FromBytesLE(b)
}

func (r *reader) done() bool {
	return r.off == len(r.bytes)
}

