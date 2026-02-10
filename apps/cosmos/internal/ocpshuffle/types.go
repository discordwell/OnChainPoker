package ocpshuffle

import "onchainpoker/apps/cosmos/internal/ocpcrypto"

type ShuffleProveOpts struct {
	Seed   []byte
	Rounds int
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

