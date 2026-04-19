package keeper

import (
	"context"
	"fmt"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"onchainpoker/apps/cosmos/x/dealer/committee"
)

// selectRandEpoch is the beacon-enabled version (see beacon.go for keeper
// integration). Tried sources, in order:
//  1. BeaconState committed to the store (produces a final or fallback value).
//  2. Caller-supplied rand_epoch (devnet / tests only).
//  3. DevnetRandEpoch (devnet / tests only).
//
// Production chain ids (not matching "devnet"/"local") MUST have a BeaconState
// available.
func (m msgServer) selectRandEpoch(ctx context.Context, epochID uint64, suppliedRandEpoch []byte) ([32]byte, error) {
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	chainID := sdkCtx.ChainID()

	// Beacon path: if BeaconState is present for this epoch and its reveal
	// window has closed, consume it. This also slashes non-revealers and
	// emits audit events.
	bs, err := m.GetBeaconState(ctx)
	if err != nil {
		return [32]byte{}, err
	}
	if bs != nil && bs.EpochId == epochID && sdkCtx.BlockHeight() > bs.RevealCloseHeight {
		return m.consumeBeaconForEpoch(ctx, epochID, chainID)
	}

	// Non-prod fallbacks.
	if !committee.IsDevnetChainID(chainID) {
		return [32]byte{}, fmt.Errorf(
			"production chain %q requires a randomness-beacon window to be opened and closed before BeginEpoch (epoch %d)",
			chainID, epochID,
		)
	}
	if len(suppliedRandEpoch) == 32 {
		var out [32]byte
		copy(out[:], suppliedRandEpoch)
		return out, nil
	}
	if len(suppliedRandEpoch) != 0 {
		return [32]byte{}, fmt.Errorf("rand_epoch must be 32 bytes or empty")
	}
	return committee.DevnetRandEpoch(ctx, epochID), nil
}

// selectRandEpochForSampling adapts the [32]byte value to the []byte signature
// expected by sampleMembers / committee.RandEpochOrDevnet.
func (m msgServer) selectRandEpochForSampling(ctx context.Context, epochID uint64, supplied []byte) ([]byte, error) {
	re, err := m.selectRandEpoch(ctx, epochID, supplied)
	if err != nil {
		return nil, err
	}
	return re[:], nil
}
