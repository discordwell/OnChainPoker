package ocpshuffle

import (
	"fmt"

	"onchainpoker/apps/chain/internal/ocpcrypto"
)

type scalarRng interface {
	NextScalar() (ocpcrypto.Scalar, error)
	NextBytes(n int) ([]byte, error)
}

type DeterministicRng struct {
	seed    []byte
	counter uint32
}

func NewDeterministicRng(seed []byte) (*DeterministicRng, error) {
	if len(seed) == 0 {
		return nil, fmt.Errorf("DeterministicRng: empty seed")
	}
	return &DeterministicRng{seed: append([]byte(nil), seed...)}, nil
}

func (r *DeterministicRng) NextScalar() (ocpcrypto.Scalar, error) {
	c := make([]byte, 4)
	c[0] = byte(r.counter)
	c[1] = byte(r.counter >> 8)
	c[2] = byte(r.counter >> 16)
	c[3] = byte(r.counter >> 24)
	r.counter++
	return ocpcrypto.HashToScalar("ocp/v1/shuffle/rng", r.seed, c)
}

func (r *DeterministicRng) NextBytes(n int) ([]byte, error) {
	if n < 0 {
		return nil, fmt.Errorf("DeterministicRng.NextBytes: invalid length")
	}
	out := make([]byte, n)
	off := 0
	for off < n {
		s, err := r.NextScalar()
		if err != nil {
			return nil, err
		}
		sb := s.Bytes()
		take := len(sb)
		if n-off < take {
			take = n - off
		}
		copy(out[off:], sb[:take])
		off += take
	}
	return out, nil
}

