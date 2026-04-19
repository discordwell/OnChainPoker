package ocpcrypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"fmt"
)

// Hybrid scalar-delivery AEAD for DKG v2.
//
// The NIZK in dkg_encshare.go proves the share POINT s*G is delivered to the
// recipient via (U, V). Downstream decryption-share proofs (Chaum-Pedersen /
// EncShare, see chaum_pedersen.go and encshare_proof.go) need the share
// SCALAR s as a witness, not just the point. This module provides the scalar
// alongside the NIZK-verified point, encrypted under a key derived from the
// same ECDH as the ElGamal ciphertext.
//
// Wire format (48 bytes):
//
//	ct = AES-256-GCM(key, iv=0^12, plaintext=scalar_bytes_LE(32), aad=proof_bytes_160)
//
// Key derivation:
//
//	key = SHA256("ocp/v1/dkg/scalar-aead/v1" || dh_bytes)
//	dh  = r * pkR (prover)  ==  skR * U (recipient)
//
// Zero IV is safe because the key is unique per (r, pkR): each share uses a
// fresh r, so the per-invocation (key, iv) pair is never repeated. The AEAD
// tag binds the ct to the NIZK proof bytes via AAD, so an attacker cannot
// splice one dealer's ct onto another's proof.
//
// Recipient validation flow (see daemon-side):
//  1. Decrypt ct -> scalar s'. If AEAD fails -> file complaint.
//  2. Verify s'*G == V - skR*U. If mismatch -> file complaint with skR*U
//     + Chaum-Pedersen proof of skR*U as evidence.

// Domain separator for the key derivation hash. MUST match the TS
// DKG_SCALAR_AEAD_KEY_DOMAIN constant byte-for-byte.
const dkgScalarAeadKeyDomain = "ocp/v1/dkg/scalar-aead/v1"

// DkgScalarAeadCtBytes is the fixed wire size of a scalar-AEAD ciphertext
// (32-byte scalar plaintext + 16-byte GCM tag).
const DkgScalarAeadCtBytes = 48

func deriveScalarAeadKey(dh Point) []byte {
	h := sha256.New()
	h.Write([]byte(dkgScalarAeadKeyDomain))
	h.Write(dh.Bytes())
	return h.Sum(nil)
}

// EncryptShareScalar AEAD-encrypts the share scalar s under a key derived
// from dh = r * pkR. The 160-byte encoded NIZK proof is bound as AAD so that
// the scalar ct is cryptographically tied to the NIZK-verified statement.
func EncryptShareScalar(pkR Point, r Scalar, s Scalar, proofBytes []byte) ([]byte, error) {
	if proofBytes == nil {
		return nil, fmt.Errorf("dkgScalarAead: proofBytes must be non-nil")
	}
	dh := MulPoint(pkR, r)
	key := deriveScalarAeadKey(dh)

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("dkgScalarAead: new cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("dkgScalarAead: new gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	pt := s.Bytes()
	out := gcm.Seal(nil, nonce, pt, proofBytes)
	if len(out) != DkgScalarAeadCtBytes {
		return nil, fmt.Errorf("dkgScalarAead: unexpected ct length %d", len(out))
	}
	return out, nil
}

// DecryptShareScalar is the recipient-side AEAD open. `u` must be the ElGamal
// ephemeral (r*G) from the matching share ciphertext; `proofBytes` is the
// 160-byte encoded NIZK proof, used as AAD. Returns an error if the AEAD tag
// check fails or the plaintext is not a canonical 32-byte scalar.
//
// IMPORTANT: this only authenticates the ct against (u, proofBytes, skR). The
// caller MUST also verify that s*G matches the share point derived from (u,
// v) + skR — otherwise the dealer could embed a scalar inconsistent with the
// NIZK-verified share point. See the docstring of the module for the full
// recipient validation flow.
func DecryptShareScalar(skR Scalar, u Point, proofBytes []byte, ct []byte) (Scalar, error) {
	if len(ct) != DkgScalarAeadCtBytes {
		return Scalar{}, fmt.Errorf("dkgScalarAead: ct must be %d bytes, got %d", DkgScalarAeadCtBytes, len(ct))
	}
	if proofBytes == nil {
		return Scalar{}, fmt.Errorf("dkgScalarAead: proofBytes must be non-nil")
	}
	dh := MulPoint(u, skR)
	key := deriveScalarAeadKey(dh)

	block, err := aes.NewCipher(key)
	if err != nil {
		return Scalar{}, fmt.Errorf("dkgScalarAead: new cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return Scalar{}, fmt.Errorf("dkgScalarAead: new gcm: %w", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	pt, err := gcm.Open(nil, nonce, ct, proofBytes)
	if err != nil {
		return Scalar{}, fmt.Errorf("dkgScalarAead: AEAD decrypt failed: %w", err)
	}
	if len(pt) != ScalarBytes {
		return Scalar{}, fmt.Errorf("dkgScalarAead: unexpected plaintext length %d", len(pt))
	}
	return ScalarFromBytesCanonical(pt)
}
