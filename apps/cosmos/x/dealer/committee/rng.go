package committee

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math/big"
)

// hashRNG is a deterministic byte stream derived from sha256(seed || counter).
// It is consensus-safe and does not depend on platform RNGs.
type hashRNG struct {
	seed    [32]byte
	counter uint64
	buf     [32]byte
	bufPos  int
}

func newHashRNG(seed [32]byte) *hashRNG {
	return &hashRNG{seed: seed, counter: 0, bufPos: len([32]byte{})}
}

func (r *hashRNG) Read(p []byte) {
	for len(p) > 0 {
		if r.bufPos >= len(r.buf) {
			r.refill()
		}
		n := copy(p, r.buf[r.bufPos:])
		r.bufPos += n
		p = p[n:]
	}
}

func (r *hashRNG) refill() {
	var in [32 + 8]byte
	copy(in[:32], r.seed[:])
	binary.LittleEndian.PutUint64(in[32:], r.counter)
	r.counter++
	r.buf = sha256.Sum256(in[:])
	r.bufPos = 0
}

func (r *hashRNG) BigIntn(max *big.Int) (*big.Int, error) {
	if max == nil || max.Sign() <= 0 {
		return nil, fmt.Errorf("max must be > 0")
	}
	if max.Cmp(big.NewInt(1)) == 0 {
		return big.NewInt(0), nil
	}

	// crypto/rand.Int-style rejection sampling:
	// draw uniformly from [0, 2^bitLen) and reject if >= max.
	bitLen := max.BitLen()
	nbytes := (bitLen + 7) / 8
	excess := uint(nbytes*8 - bitLen) // 0..7

	buf := make([]byte, nbytes)
	for tries := 0; tries < 1_000_000; tries++ {
		r.Read(buf)
		if excess != 0 {
			buf[0] &= byte(0xff >> excess)
		}

		v := new(big.Int).SetBytes(buf)
		if v.Cmp(max) < 0 {
			return v, nil
		}
	}

	return nil, fmt.Errorf("failed to draw BigIntn after many tries (max=%s)", max.String())
}
