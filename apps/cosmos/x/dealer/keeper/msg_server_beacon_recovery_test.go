package keeper

// Regression tests for the height-gated stuck-beacon recovery added in
// commits f658ecb (openBeacon + MaybeAutoOpenBeacon post-upgrade overwrite
// path) and b2393b1 (preserve consumable beacons through the recovery path).
//
// These tests deliberately drive the simulated block height to values
// `>= beaconStuckRecoveryHeight` (= 1_036_000). The pre-existing beacon
// tests all run at low heights (typically 10) and therefore only exercise
// the pre-upgrade code path; they cannot regress the new three-way
// preUpgrade/live/consumable logic on their own.

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"

	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

// postUpgradeHeight is one block past the recovery gate. Anything `>=
// beaconStuckRecoveryHeight` is post-upgrade; using +1 makes the intent
// explicit at test sites without coupling them to the exact constant value.
const postUpgradeHeight int64 = beaconStuckRecoveryHeight + 1

// preUpgradeHeight is well below the recovery gate so the legacy branch
// is exercised. Mirrors the height used by the existing beacon tests.
const preUpgradeHeight int64 = 10

// recoveryFixture is the common harness setup for these tests. It returns
// a context anchored at the requested simulated height and a Keeper that
// has NextEpochID seeded to 3 (so MaybeAutoOpenBeacon has a valid target
// epoch to overwrite into).
func recoveryFixture(t *testing.T, height int64) (context.Context, Keeper) {
	t.Helper()
	_, _, v := beaconValidator(t, 0xa1)
	ctx, k, _, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), height, []stakingtypes.Validator{v})
	require.NoError(t, k.SetNextEpochID(ctx, 3))
	return ctx, k
}

// --- MaybeAutoOpenBeacon ---------------------------------------------------

// At pre-upgrade heights, MaybeAutoOpenBeacon must leave an expired-but-
// unconsumed beacon untouched. This preserves deterministic replay of
// historical blocks where the chain was stuck.
func TestMaybeAutoOpenBeacon_PreUpgrade_DoesNotOverwriteExpiredUnconsumed(t *testing.T) {
	ctx, k := recoveryFixture(t, preUpgradeHeight)

	stuck := &dealertypes.BeaconState{
		EpochId:           2,
		CommitOpenHeight:  preUpgradeHeight - 5,
		CommitCloseHeight: preUpgradeHeight - 3,
		RevealCloseHeight: preUpgradeHeight - 1, // expired
		Threshold:         2,
		// 0 reveals → would be stuck post-upgrade, but pre-upgrade keeps it.
	}
	require.NoError(t, k.SetBeaconState(ctx, stuck))

	require.NoError(t, k.MaybeAutoOpenBeacon(ctx))

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.NotNil(t, bs)
	require.Equal(t, uint64(2), bs.EpochId, "pre-upgrade must not overwrite expired beacon")
	require.Equal(t, stuck.CommitOpenHeight, bs.CommitOpenHeight)
	require.Equal(t, stuck.RevealCloseHeight, bs.RevealCloseHeight)
}

// At post-upgrade heights, an expired-and-unconsumed beacon with too few
// reveals to finalize is "stuck" and must be overwritten with a fresh
// window targeting NextEpochID. This is the f658ecb recovery path.
func TestMaybeAutoOpenBeacon_PostUpgrade_OverwritesExpiredUnconsumedStuck(t *testing.T) {
	ctx, k := recoveryFixture(t, postUpgradeHeight)

	stuck := &dealertypes.BeaconState{
		EpochId:           2,
		CommitOpenHeight:  postUpgradeHeight - 100,
		CommitCloseHeight: postUpgradeHeight - 50,
		RevealCloseHeight: postUpgradeHeight - 10, // expired
		Threshold:         2,
		// 0 reveals < threshold 2 → genuinely stuck, no consumption path.
	}
	require.NoError(t, k.SetBeaconState(ctx, stuck))

	require.NoError(t, k.MaybeAutoOpenBeacon(ctx))

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.NotNil(t, bs)
	// New beacon targets NextEpochID (3), not the stale 2.
	require.Equal(t, uint64(3), bs.EpochId)
	require.Equal(t, postUpgradeHeight, bs.CommitOpenHeight, "new commit window starts at current height")
	// Devnet defaults are 5/5 (harness chainID is ocp-devnet-1).
	require.Equal(t, postUpgradeHeight+5, bs.CommitCloseHeight)
	require.Equal(t, postUpgradeHeight+10, bs.RevealCloseHeight)
	require.Equal(t, uint32(2), bs.Threshold, "no epoch in fixture → auto-open uses the protocol minimum threshold of 2")
	require.Empty(t, bs.Final)
	require.Empty(t, bs.Reveals)
	require.Empty(t, bs.Commits)
}

// Regression for b2393b1: an expired beacon that has enough reveals to be
// finalized by the next BeginEpoch must NOT be overwritten, even though
// its window has closed. Overwriting a consumable beacon would destroy a
// seed that downstream BeginEpoch is about to consume.
func TestMaybeAutoOpenBeacon_PostUpgrade_PreservesExpiredButConsumable(t *testing.T) {
	ctx, k := recoveryFixture(t, postUpgradeHeight)

	consumable := &dealertypes.BeaconState{
		EpochId:           2,
		CommitOpenHeight:  postUpgradeHeight - 100,
		CommitCloseHeight: postUpgradeHeight - 50,
		RevealCloseHeight: postUpgradeHeight - 10, // expired window
		Threshold:         2,
		Commits: []dealertypes.BeaconCommitEntry{
			{Validator: "valA", Commit: bytes.Repeat([]byte{0x01}, 32)},
			{Validator: "valB", Commit: bytes.Repeat([]byte{0x02}, 32)},
		},
		// reveals >= threshold → BeginEpoch can still consume this beacon.
		Reveals: []dealertypes.BeaconRevealEntry{
			{Validator: "valA", Salt: bytes.Repeat([]byte{0x11}, 32)},
			{Validator: "valB", Salt: bytes.Repeat([]byte{0x12}, 32)},
		},
	}
	require.NoError(t, k.SetBeaconState(ctx, consumable))

	require.NoError(t, k.MaybeAutoOpenBeacon(ctx))

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.NotNil(t, bs)
	require.Equal(t, uint64(2), bs.EpochId, "consumable beacon must be preserved")
	require.Equal(t, consumable.CommitOpenHeight, bs.CommitOpenHeight)
	require.Equal(t, consumable.RevealCloseHeight, bs.RevealCloseHeight)
	require.Len(t, bs.Reveals, 2, "reveals must be preserved")
	require.Len(t, bs.Commits, 2, "commits must be preserved")
}

// At post-upgrade heights, a beacon whose reveal window is still in the
// future is "live" — committers/revealers can still participate. Auto-open
// must leave it alone.
func TestMaybeAutoOpenBeacon_PostUpgrade_PreservesLiveBeacon(t *testing.T) {
	ctx, k := recoveryFixture(t, postUpgradeHeight)

	live := &dealertypes.BeaconState{
		EpochId:           2,
		CommitOpenHeight:  postUpgradeHeight - 2,
		CommitCloseHeight: postUpgradeHeight + 3,
		RevealCloseHeight: postUpgradeHeight + 8, // still in the future
		Threshold:         2,
	}
	require.NoError(t, k.SetBeaconState(ctx, live))

	require.NoError(t, k.MaybeAutoOpenBeacon(ctx))

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.Equal(t, uint64(2), bs.EpochId, "live beacon preserved")
	require.Equal(t, live.RevealCloseHeight, bs.RevealCloseHeight)
}

// A consumed beacon (Final populated) that still targets NextEpochID is an
// audit row sitting in state between consume-time and the next epoch
// advance. Auto-open must not destroy that audit data while it's still
// for the current next epoch.
func TestMaybeAutoOpenBeacon_PostUpgrade_PreservesConsumedBeacon(t *testing.T) {
	ctx, k := recoveryFixture(t, postUpgradeHeight) // NextEpochID = 3

	consumed := &dealertypes.BeaconState{
		EpochId:           3, // same as NextEpochID
		CommitOpenHeight:  postUpgradeHeight - 100,
		CommitCloseHeight: postUpgradeHeight - 50,
		RevealCloseHeight: postUpgradeHeight - 10,
		Threshold:         2,
		Final:             bytes.Repeat([]byte{0xcd}, 32), // consumed
	}
	require.NoError(t, k.SetBeaconState(ctx, consumed))

	require.NoError(t, k.MaybeAutoOpenBeacon(ctx))

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.NotEmpty(t, bs.Final, "consumed-for-current-epoch beacon preserved")
	require.Equal(t, uint64(3), bs.EpochId)
	require.Equal(t, consumed.Final, bs.Final)
}

// --- auto-open threshold inheritance ----------------------------------------

// Auto-open must inherit the current epoch's DKG threshold so a wider
// committee (t > 2) never gets a beacon that finalizes with fewer reveals
// than the epoch's own security parameter. Previously the call site
// hardcoded threshold=2 regardless of epoch config.
func TestMaybeAutoOpenBeacon_InheritsEpochThreshold(t *testing.T) {
	ctx, k := recoveryFixture(t, postUpgradeHeight)

	require.NoError(t, k.SetEpoch(ctx, &dealertypes.DealerEpoch{
		EpochId:   2,
		Threshold: 3,
	}))

	// No beacon state stored → the plain auto-open path fires.
	require.NoError(t, k.MaybeAutoOpenBeacon(ctx))

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.NotNil(t, bs)
	require.Equal(t, uint64(3), bs.EpochId)
	require.Equal(t, uint32(3), bs.Threshold, "auto-open must inherit the epoch's threshold")
}

// A legacy epoch with threshold=1 (as epochs 1-41 ran on the live testnet)
// must be floored to openBeacon's protocol minimum of 2. This is also the
// replay-safety property: max(2, t) equals the previously hardcoded 2 at
// every historical height, so no height gate is needed for this change.
func TestMaybeAutoOpenBeacon_FloorsLegacyEpochThreshold(t *testing.T) {
	ctx, k := recoveryFixture(t, postUpgradeHeight)

	require.NoError(t, k.SetEpoch(ctx, &dealertypes.DealerEpoch{
		EpochId:   2,
		Threshold: 1,
	}))

	require.NoError(t, k.MaybeAutoOpenBeacon(ctx))

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.NotNil(t, bs)
	require.Equal(t, uint32(2), bs.Threshold, "legacy threshold=1 epochs floor to the protocol minimum")
}

// The stuck-overwrite recovery branch goes through the same call site and
// must inherit the epoch threshold too — this was the exact quirk flagged
// when the recovery path landed (openBeacon(ctx, nextEpoch, 0, 0, 2)).
func TestMaybeAutoOpenBeacon_PostUpgrade_StuckOverwriteInheritsEpochThreshold(t *testing.T) {
	ctx, k := recoveryFixture(t, postUpgradeHeight)

	require.NoError(t, k.SetEpoch(ctx, &dealertypes.DealerEpoch{
		EpochId:   2,
		Threshold: 3,
	}))

	stuck := &dealertypes.BeaconState{
		EpochId:           2,
		CommitOpenHeight:  postUpgradeHeight - 100,
		CommitCloseHeight: postUpgradeHeight - 50,
		RevealCloseHeight: postUpgradeHeight - 10, // expired
		Threshold:         2,
		// 0 reveals < threshold → stuck, overwrite-eligible.
	}
	require.NoError(t, k.SetBeaconState(ctx, stuck))

	require.NoError(t, k.MaybeAutoOpenBeacon(ctx))

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.NotNil(t, bs)
	require.Equal(t, uint64(3), bs.EpochId, "stuck beacon replaced with one for NextEpochID")
	require.Equal(t, uint32(3), bs.Threshold, "recovery overwrite must inherit the epoch's threshold")
}

// --- openBeacon ------------------------------------------------------------

// Pre-upgrade, openBeacon refuses any unconsumed beacon — expired or not.
// This is the legacy "beacon window already open" guard.
func TestOpenBeacon_PreUpgrade_RejectsExpiredUnconsumed(t *testing.T) {
	ctx, k := recoveryFixture(t, preUpgradeHeight)

	existing := &dealertypes.BeaconState{
		EpochId:           1,
		CommitOpenHeight:  preUpgradeHeight - 5,
		CommitCloseHeight: preUpgradeHeight - 3,
		RevealCloseHeight: preUpgradeHeight - 1, // expired
		Threshold:         2,
	}
	require.NoError(t, k.SetBeaconState(ctx, existing))

	_, err := k.openBeacon(ctx, 2, 5, 5, 2)
	require.ErrorContains(t, err, "beacon window already open")
}

// Post-upgrade, openBeacon must still reject when a beacon's reveal window
// is still in the future — committers/revealers might still post.
func TestOpenBeacon_PostUpgrade_RejectsLive(t *testing.T) {
	ctx, k := recoveryFixture(t, postUpgradeHeight)

	live := &dealertypes.BeaconState{
		EpochId:           2,
		CommitOpenHeight:  postUpgradeHeight - 2,
		CommitCloseHeight: postUpgradeHeight + 3,
		RevealCloseHeight: postUpgradeHeight + 8, // still in the future
		Threshold:         2,
	}
	require.NoError(t, k.SetBeaconState(ctx, live))

	_, err := k.openBeacon(ctx, 3, 5, 5, 2)
	require.ErrorContains(t, err, "beacon window already open")

	// Confirm the live beacon was not mutated.
	bs, getErr := k.GetBeaconState(ctx)
	require.NoError(t, getErr)
	require.Equal(t, uint64(2), bs.EpochId)
}

// Post-upgrade, openBeacon must refuse to overwrite a consumable beacon
// (expired-window but `len(Reveals) >= Threshold`). Allowing overwrite
// would destroy a seed BeginEpoch is about to consume. Regression for
// b2393b1.
func TestOpenBeacon_PostUpgrade_RejectsConsumable(t *testing.T) {
	ctx, k := recoveryFixture(t, postUpgradeHeight)

	consumable := &dealertypes.BeaconState{
		EpochId:           2,
		CommitOpenHeight:  postUpgradeHeight - 100,
		CommitCloseHeight: postUpgradeHeight - 50,
		RevealCloseHeight: postUpgradeHeight - 10, // expired
		Threshold:         2,
		Commits: []dealertypes.BeaconCommitEntry{
			{Validator: "valA", Commit: bytes.Repeat([]byte{0x01}, 32)},
			{Validator: "valB", Commit: bytes.Repeat([]byte{0x02}, 32)},
		},
		Reveals: []dealertypes.BeaconRevealEntry{
			{Validator: "valA", Salt: bytes.Repeat([]byte{0x11}, 32)},
			{Validator: "valB", Salt: bytes.Repeat([]byte{0x12}, 32)},
		},
	}
	require.NoError(t, k.SetBeaconState(ctx, consumable))

	_, err := k.openBeacon(ctx, 3, 5, 5, 2)
	require.ErrorContains(t, err, "beacon window already open")

	// Confirm the consumable beacon's reveals survive.
	bs, getErr := k.GetBeaconState(ctx)
	require.NoError(t, getErr)
	require.Len(t, bs.Reveals, 2, "consumable reveals must not be destroyed")
}

// Post-upgrade, openBeacon must succeed and overwrite a genuinely stuck
// beacon (expired window AND `len(Reveals) < Threshold`). This is the
// recovery escape hatch added in f658ecb.
func TestOpenBeacon_PostUpgrade_AllowsStuckOverwrite(t *testing.T) {
	ctx, k := recoveryFixture(t, postUpgradeHeight)

	stuck := &dealertypes.BeaconState{
		EpochId:           2,
		CommitOpenHeight:  postUpgradeHeight - 100,
		CommitCloseHeight: postUpgradeHeight - 50,
		RevealCloseHeight: postUpgradeHeight - 10, // expired
		Threshold:         2,
		// 0 reveals < threshold 2 → stuck.
	}
	require.NoError(t, k.SetBeaconState(ctx, stuck))

	opened, err := k.openBeacon(ctx, 3, 5, 5, 2)
	require.NoError(t, err)
	require.NotNil(t, opened)
	require.Equal(t, uint64(3), opened.EpochId)
	require.Equal(t, postUpgradeHeight, opened.CommitOpenHeight)
	require.Equal(t, postUpgradeHeight+5, opened.CommitCloseHeight)
	require.Equal(t, postUpgradeHeight+10, opened.RevealCloseHeight)
	require.Equal(t, uint32(2), opened.Threshold)
	require.Empty(t, opened.Final)
	require.Empty(t, opened.Reveals)
	require.Empty(t, opened.Commits)

	// Re-read from store to confirm the overwrite persisted.
	bs, getErr := k.GetBeaconState(ctx)
	require.NoError(t, getErr)
	require.Equal(t, uint64(3), bs.EpochId)
	require.Equal(t, postUpgradeHeight, bs.CommitOpenHeight)
}
