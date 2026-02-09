package ocpcrypto

import (
	"crypto/sha512"
	"fmt"
	"hash"
)

var (
	hashToScalarPrefix = []byte("OCPv1|hash_to_scalar|")
)

func updateLenBytes(h hash.Hash, b []byte) {
	h.Write(u32le(uint32(len(b))))
	h.Write(b)
}

// HashToScalar implements docs/INTERFACES.md 4.1 and WS3 hashToScalar.
func HashToScalar(domainSep string, msgs ...[]byte) (Scalar, error) {
	h := sha512.New()
	h.Write(hashToScalarPrefix)
	updateLenBytes(h, []byte(domainSep))
	for _, m := range msgs {
		if m == nil {
			return Scalar{}, fmt.Errorf("hashToScalar: nil msg")
		}
		updateLenBytes(h, m)
	}
	digest := h.Sum(nil) // 64 bytes
	return ScalarFromUniformBytes(digest)
}

