package committee

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

const (
	// Keep these domains stable; they become part of consensus-critical derivations.
	dkgRandDomain      = "ocp/v1/dkg/rand"
	dkgCommitteeDomain = "ocp/v1/dkg/committee"
)

// DevnetRandEpoch derives a 32-byte randomness value deterministically from
// (chain-id, height, last-block-hash, epochID). This is suitable for devnets.
//
// Security note: using block-derived entropy is proposer-influenceable. Production
// should replace this with a proper randomness beacon or commit-reveal scheme.
func DevnetRandEpoch(ctx context.Context, epochID uint64) [32]byte {
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	return DevnetRandEpochFrom(sdkCtx.ChainID(), sdkCtx.BlockHeight(), sdkCtx.BlockHeader().LastBlockId.Hash, epochID)
}

// RandEpochOrDevnet returns the provided randEpoch if present (must be 32 bytes),
// otherwise derives devnet randomness via DevnetRandEpoch.
func RandEpochOrDevnet(ctx context.Context, epochID uint64, randEpoch []byte) ([32]byte, error) {
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	return RandEpochOrDevnetFrom(sdkCtx.ChainID(), sdkCtx.BlockHeight(), sdkCtx.BlockHeader().LastBlockId.Hash, epochID, randEpoch)
}

// RandEpochOrDevnetFrom is a pure version of RandEpochOrDevnet for easy testing.
func RandEpochOrDevnetFrom(chainID string, height int64, lastBlockHash []byte, epochID uint64, randEpoch []byte) ([32]byte, error) {
	if len(randEpoch) == 0 {
		return DevnetRandEpochFrom(chainID, height, lastBlockHash, epochID), nil
	}
	if len(randEpoch) != 32 {
		return [32]byte{}, fmt.Errorf("randEpoch must be 32 bytes (or omitted)")
	}

	var out [32]byte
	copy(out[:], randEpoch)
	return out, nil
}

// DevnetRandEpochFrom is a pure version of DevnetRandEpoch for easy testing.
func DevnetRandEpochFrom(chainID string, height int64, lastBlockHash []byte, epochID uint64) [32]byte {
	var h8 [8]byte
	var e8 [8]byte
	binary.LittleEndian.PutUint64(h8[:], uint64(height))
	binary.LittleEndian.PutUint64(e8[:], epochID)
	return hashDomain(dkgRandDomain,
		[]byte(chainID),
		h8[:],
		e8[:],
		lastBlockHash,
	)
}

// CommitteeSeed derives the deterministic seed for committee selection from a
// randEpoch and the epochID.
func CommitteeSeed(randEpoch [32]byte, epochID uint64) [32]byte {
	var e8 [8]byte
	binary.LittleEndian.PutUint64(e8[:], epochID)
	return hashDomain(dkgCommitteeDomain, randEpoch[:], e8[:])
}

func hashDomain(domain string, parts ...[]byte) [32]byte {
	h := sha256.New()
	_, _ = h.Write([]byte(domain))

	// Length-prefix each part to avoid ambiguous concatenations.
	var lenBuf [4]byte
	for _, p := range parts {
		binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(p)))
		_, _ = h.Write(lenBuf[:])
		_, _ = h.Write(p)
	}

	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}
