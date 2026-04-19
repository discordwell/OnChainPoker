package ocpshuffle

import "onchainpoker/apps/cosmos/internal/ocpcrypto"

type ShuffleProveOpts struct {
	Seed   []byte
	Rounds int
	// Context bytes bound into every Fiat-Shamir transcript in the proof.
	// If nil, the prover emits a legacy v1 proof (no context binding).
	// Must be non-empty to emit v2. Canonical format (shared byte-for-byte
	// with TS): u64le(tableId) || u64le(handId) || u16le(round) ||
	// u16le(shufflerLen) || shuffler_utf8.
	Context []byte
}

type ShuffleProveResult struct {
	DeckOut    []ocpcrypto.ElGamalCiphertext
	ProofBytes []byte
}

type ShuffleVerifyResult struct {
	OK     bool
	Error  string
	DeckOut []ocpcrypto.ElGamalCiphertext
}

