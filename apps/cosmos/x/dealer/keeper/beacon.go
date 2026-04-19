// Package keeper: randomness-beacon commit-reveal integration.
//
// This file is gated behind the `dealer_beacon_regen` build tag because it
// references protobuf-generated types (BeaconState, BeaconCommitEntry,
// BeaconRevealEntry, MsgBeaconCommit, MsgBeaconReveal) that have been added
// to apps/cosmos/proto/onchainpoker/dealer/v1/{tx,dealer}.proto but have NOT
// yet had their .pb.go regenerated. Regenerate with:
//
//	cd apps/cosmos/proto && buf generate
//
// then drop the build tag (`sed -i '' '/^\/\/go:build/,/^$/d' beacon.go` or
// by hand) to enable the beacon path.
//
// The pure helpers in x/dealer/committee/beacon.go are always compiled and
// unit-tested regardless of this tag; only the keeper wiring is gated.
package keeper

import (
	"context"
	"fmt"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"onchainpoker/apps/cosmos/x/dealer/committee"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

// ---- Beacon KV helpers ----

func (k Keeper) GetBeaconState(ctx context.Context) (*dealertypes.BeaconState, error) {
	store := k.storeService.OpenKVStore(ctx)
	bz, err := store.Get(dealertypes.BeaconStateKey)
	if err != nil {
		return nil, err
	}
	if bz == nil {
		return nil, nil
	}
	var bs dealertypes.BeaconState
	if err := k.cdc.Unmarshal(bz, &bs); err != nil {
		return nil, err
	}
	return &bs, nil
}

func (k Keeper) SetBeaconState(ctx context.Context, bs *dealertypes.BeaconState) error {
	store := k.storeService.OpenKVStore(ctx)
	if bs == nil {
		return store.Delete(dealertypes.BeaconStateKey)
	}
	bz, err := k.cdc.Marshal(bs)
	if err != nil {
		return err
	}
	return store.Set(dealertypes.BeaconStateKey, bz)
}

// ---- Msg handlers ----

func (m msgServer) BeaconCommit(ctx context.Context, req *dealertypes.MsgBeaconCommit) (*dealertypes.MsgBeaconCommitResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Validator == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing validator")
	}
	valAddr, err := sdk.ValAddressFromBech32(req.Validator)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid validator address")
	}
	if err := committee.VerifyCommitSyntax(req.Commit); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap(err.Error())
	}

	// Gate by active-bonded set. requireActiveBondedCaller takes the caller's
	// acc-bech32; derive it from the validator operator bytes.
	if err := m.requireActiveBondedCaller(ctx, sdk.AccAddress(valAddr).String()); err != nil {
		return nil, err
	}

	bs, err := m.GetBeaconState(ctx)
	if err != nil {
		return nil, err
	}
	if bs == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("no beacon window open")
	}
	if req.EpochId != bs.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch_id mismatch")
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	h := sdkCtx.BlockHeight()
	if h < bs.CommitOpenHeight {
		return nil, dealertypes.ErrInvalidRequest.Wrap("commit window not yet open")
	}
	if h > bs.CommitCloseHeight {
		return nil, dealertypes.ErrInvalidRequest.Wrap("commit window closed")
	}

	for _, c := range bs.Commits {
		if c.Validator == req.Validator {
			return nil, dealertypes.ErrInvalidRequest.Wrap("commit already submitted")
		}
	}

	bs.Commits = append(bs.Commits, dealertypes.BeaconCommitEntry{
		Validator: req.Validator,
		Commit:    append([]byte(nil), req.Commit...),
	})
	sortBeaconCommits(bs)

	if err := m.SetBeaconState(ctx, bs); err != nil {
		return nil, err
	}

	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeBeaconCommitted,
		sdk.NewAttribute("epochId", fmt.Sprintf("%d", bs.EpochId)),
		sdk.NewAttribute("validator", req.Validator),
	))
	return &dealertypes.MsgBeaconCommitResponse{}, nil
}

func (m msgServer) BeaconReveal(ctx context.Context, req *dealertypes.MsgBeaconReveal) (*dealertypes.MsgBeaconRevealResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Validator == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing validator")
	}
	valAddr, err := sdk.ValAddressFromBech32(req.Validator)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid validator address")
	}
	if len(req.Salt) != committee.BeaconSaltBytes {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("salt must be %d bytes", committee.BeaconSaltBytes)
	}

	// Gate by active-bonded set — symmetric with BeaconCommit so that only
	// current bonded validators can participate (prevents replay griefing
	// from old operators and keeps the message surface consistent).
	if err := m.requireActiveBondedCaller(ctx, sdk.AccAddress(valAddr).String()); err != nil {
		return nil, err
	}

	bs, err := m.GetBeaconState(ctx)
	if err != nil {
		return nil, err
	}
	if bs == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("no beacon window open")
	}
	if req.EpochId != bs.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch_id mismatch")
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	h := sdkCtx.BlockHeight()
	// Reveals are only accepted after the commit window has closed (so that
	// the full commit set is fixed), and before the reveal window ends.
	if h <= bs.CommitCloseHeight {
		return nil, dealertypes.ErrInvalidRequest.Wrap("reveal window not yet open")
	}
	if h > bs.RevealCloseHeight {
		return nil, dealertypes.ErrInvalidRequest.Wrap("reveal window closed")
	}

	// Must have committed.
	var stored []byte
	for _, c := range bs.Commits {
		if c.Validator == req.Validator {
			stored = c.Commit
			break
		}
	}
	if stored == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("no commit from this validator")
	}

	for _, r := range bs.Reveals {
		if r.Validator == req.Validator {
			return nil, dealertypes.ErrInvalidRequest.Wrap("reveal already submitted")
		}
	}

	if err := committee.Reveal(req.Validator, req.EpochId, req.Salt, stored); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap(err.Error())
	}

	bs.Reveals = append(bs.Reveals, dealertypes.BeaconRevealEntry{
		Validator: req.Validator,
		Salt:      append([]byte(nil), req.Salt...),
	})
	sortBeaconReveals(bs)

	if err := m.SetBeaconState(ctx, bs); err != nil {
		return nil, err
	}

	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeBeaconRevealed,
		sdk.NewAttribute("epochId", fmt.Sprintf("%d", bs.EpochId)),
		sdk.NewAttribute("validator", req.Validator),
	))
	return &dealertypes.MsgBeaconRevealResponse{}, nil
}

// ---- Integration: consumeBeaconForEpoch is called from BeginEpoch to get a
// 32-byte randEpoch value. It finalizes the beacon (or falls back) and emits
// audit events. It also slashes committed-but-unrevealed validators.
//
// Preconditions:
//   - A BeaconState for `epochID` must already be written to the store with
//     its RevealCloseHeight in the past. The caller is responsible for
//     opening the beacon window in a prior block (see OpenBeaconWindow).
func (m msgServer) consumeBeaconForEpoch(ctx context.Context, epochID uint64, chainID string) ([32]byte, error) {
	bs, err := m.GetBeaconState(ctx)
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	if err != nil {
		return [32]byte{}, err
	}

	// If no beacon state exists or epoch doesn't match, fall back on devnet
	// chains, otherwise refuse.
	if bs == nil || bs.EpochId != epochID {
		if committee.IsDevnetChainID(chainID) {
			re := committee.DevnetRandEpoch(ctx, epochID)
			sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
				dealertypes.EventTypeBeaconFallback,
				sdk.NewAttribute("epochId", fmt.Sprintf("%d", epochID)),
				sdk.NewAttribute("reason", "no-beacon-state"),
				sdk.NewAttribute("chainId", chainID),
			))
			return re, nil
		}
		return [32]byte{}, dealertypes.ErrInvalidRequest.Wrap("beacon state missing for epoch; production chains must open a beacon window before BeginEpoch")
	}

	// Window must be closed.
	if sdkCtx.BlockHeight() <= bs.RevealCloseHeight {
		return [32]byte{}, dealertypes.ErrInvalidRequest.Wrap("reveal window still open")
	}

	// Slash committed-but-unrevealed validators.
	missing := beaconMissingReveals(bs)
	if len(missing) > 0 {
		params, err := m.GetParams(ctx)
		if err != nil {
			return [32]byte{}, err
		}
		slashFraction := bpsToDec(params.SlashBpsDkg)
		jailDuration := time.Duration(params.JailSecondsDkg) * time.Second
		// Distribution height is "now" for beacon faults — the beacon window
		// is short and precedes the DKG, so no stake-snapshot was captured.
		distH := sdkCtx.BlockHeight()
		for _, v := range missing {
			// Best-effort power read; for a commit-but-no-reveal the
			// validator's current power is a reasonable proxy.
			acc, err := sdk.ValAddressFromBech32(v)
			if err != nil {
				continue
			}
			val, _ := m.stakingKeeper.Validator(ctx, acc)
			var power int64
			if val != nil {
				power = val.GetConsensusPower(sdk.DefaultPowerReduction)
			}
			if err := m.applyPenalty(ctx, v, distH, power, slashFraction, jailDuration); err != nil {
				return [32]byte{}, err
			}
			sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
				dealertypes.EventTypeValidatorSlashed,
				sdk.NewAttribute("epochId", fmt.Sprintf("%d", epochID)),
				sdk.NewAttribute("validator", v),
				sdk.NewAttribute("reason", "beacon-missing-reveal"),
				sdk.NewAttribute("slashFraction", slashFraction.String()),
				sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", distH)),
			))
		}
	}

	// Compute final beacon.
	revs := make([]committee.BeaconReveal, 0, len(bs.Reveals))
	for _, r := range bs.Reveals {
		revs = append(revs, committee.BeaconReveal{Validator: r.Validator, Salt: r.Salt})
	}
	final, ok, err := committee.Final(chainID, epochID, revs, int(bs.Threshold))
	if err != nil {
		return [32]byte{}, err
	}
	if !ok {
		// Below threshold — fall back if chain id allows, else refuse.
		if !committee.IsDevnetChainID(chainID) {
			return [32]byte{}, dealertypes.ErrInvalidRequest.Wrap("beacon below threshold and chain is not devnet/local")
		}
		re := committee.DevnetRandEpoch(ctx, epochID)
		bs.Final = append([]byte(nil), re[:]...)
		bs.Fallback = true
		if err := m.SetBeaconState(ctx, bs); err != nil {
			return [32]byte{}, err
		}
		sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
			dealertypes.EventTypeBeaconFallback,
			sdk.NewAttribute("epochId", fmt.Sprintf("%d", epochID)),
			sdk.NewAttribute("reason", "below-threshold"),
			sdk.NewAttribute("reveals", fmt.Sprintf("%d", len(revs))),
			sdk.NewAttribute("threshold", fmt.Sprintf("%d", bs.Threshold)),
		))
		return re, nil
	}

	bs.Final = append([]byte(nil), final[:]...)
	bs.Fallback = false
	if err := m.SetBeaconState(ctx, bs); err != nil {
		return [32]byte{}, err
	}
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeBeaconFinalized,
		sdk.NewAttribute("epochId", fmt.Sprintf("%d", epochID)),
		sdk.NewAttribute("reveals", fmt.Sprintf("%d", len(revs))),
		sdk.NewAttribute("final", fmt.Sprintf("%x", final)),
	))
	return final, nil
}

// beaconMissingReveals mirrors committee.MissingReveals but operates on the
// stored proto types.
func beaconMissingReveals(bs *dealertypes.BeaconState) []string {
	if bs == nil {
		return nil
	}
	rev := make(map[string]struct{}, len(bs.Reveals))
	for _, r := range bs.Reveals {
		rev[r.Validator] = struct{}{}
	}
	out := make([]string, 0)
	for _, c := range bs.Commits {
		if _, ok := rev[c.Validator]; ok {
			continue
		}
		out = append(out, c.Validator)
	}
	return out
}

func sortBeaconCommits(bs *dealertypes.BeaconState) {
	if bs == nil {
		return
	}
	slice := bs.Commits
	for i := 1; i < len(slice); i++ {
		for j := i; j > 0 && slice[j-1].Validator > slice[j].Validator; j-- {
			slice[j], slice[j-1] = slice[j-1], slice[j]
		}
	}
}

func sortBeaconReveals(bs *dealertypes.BeaconState) {
	if bs == nil {
		return
	}
	slice := bs.Reveals
	for i := 1; i < len(slice); i++ {
		for j := i; j > 0 && slice[j-1].Validator > slice[j].Validator; j-- {
			slice[j], slice[j-1] = slice[j-1], slice[j]
		}
	}
}
