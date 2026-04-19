package keeper

import (
	"bytes"
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	sdk "github.com/cosmos/cosmos-sdk/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"

	"onchainpoker/apps/cosmos/x/dealer/committee"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

// --- Test helpers ----------------------------------------------------------

// beaconValidator produces matching (caller-acc, valoper) bech32 strings
// derived from the same 20-byte key. requireActiveBondedCaller enforces that
// the caller's AccAddress bytes re-encoded as ValAddress equal the bonded
// validator's operator, so the two addresses must share a key.
func beaconValidator(t *testing.T, seed byte) (accStr, valoperStr string, bonded stakingtypes.Validator) {
	t.Helper()
	keyBytes := bytes.Repeat([]byte{seed}, 20)
	acc := sdk.AccAddress(keyBytes).String()
	valoper := sdk.ValAddress(keyBytes).String()
	v := makeBondedValidatorForDealerTest(t, valoper, 1, seed)
	return acc, valoper, v
}

// beaconSetCtxHeight returns a copy of ctx with the block height overridden,
// reusing the original store and event manager. The beacon flow depends
// heavily on block-height windows, so tests need to advance the clock.
func beaconSetCtxHeight(ctx context.Context, h int64) context.Context {
	sdkCtx := sdk.UnwrapSDKContext(ctx).WithBlockHeight(h)
	return sdk.WrapSDKContext(sdkCtx)
}

// --- OpenBeaconWindow ------------------------------------------------------

func TestOpenBeaconWindow_HappyPath(t *testing.T) {
	acc, _, v := beaconValidator(t, 0x51)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	_, err := ms.OpenBeaconWindow(ctx, &dealertypes.MsgOpenBeaconWindow{
		Caller:       acc,
		EpochId:      7,
		CommitBlocks: 5,
		RevealBlocks: 8,
		Threshold:    2,
	})
	require.NoError(t, err)

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.NotNil(t, bs)
	require.Equal(t, uint64(7), bs.EpochId)
	require.Equal(t, int64(10), bs.CommitOpenHeight)
	require.Equal(t, int64(15), bs.CommitCloseHeight)
	require.Equal(t, int64(23), bs.RevealCloseHeight)
	require.Equal(t, uint32(2), bs.Threshold)
	require.Empty(t, bs.Commits)
	require.Empty(t, bs.Reveals)
	require.Empty(t, bs.Final)
	require.False(t, bs.Fallback)
}

func TestOpenBeaconWindow_DefaultsApplied(t *testing.T) {
	acc, _, v := beaconValidator(t, 0x52)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 42, []stakingtypes.Validator{v})

	_, err := ms.OpenBeaconWindow(ctx, &dealertypes.MsgOpenBeaconWindow{
		Caller:  acc,
		EpochId: 9,
		// commit_blocks, reveal_blocks, threshold all zero → use defaults.
	})
	require.NoError(t, err)

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.NotNil(t, bs)
	require.Equal(t, int64(42+5), bs.CommitCloseHeight)
	require.Equal(t, int64(42+5+5), bs.RevealCloseHeight)
	require.Equal(t, uint32(1), bs.Threshold) // defaults to 1
}

func TestOpenBeaconWindow_NonBondedCallerRejected(t *testing.T) {
	_, _, v := beaconValidator(t, 0x53)
	attackerAcc := sdk.AccAddress(bytes.Repeat([]byte{0x99}, 20)).String()
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 5, []stakingtypes.Validator{v})

	_, err := ms.OpenBeaconWindow(ctx, &dealertypes.MsgOpenBeaconWindow{
		Caller:  attackerAcc,
		EpochId: 1,
	})
	require.ErrorContains(t, err, "active bonded")
}

func TestOpenBeaconWindow_ReopenRejected(t *testing.T) {
	acc, _, v := beaconValidator(t, 0x54)
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 5, []stakingtypes.Validator{v})

	_, err := ms.OpenBeaconWindow(ctx, &dealertypes.MsgOpenBeaconWindow{
		Caller: acc, EpochId: 1,
	})
	require.NoError(t, err)

	_, err = ms.OpenBeaconWindow(ctx, &dealertypes.MsgOpenBeaconWindow{
		Caller: acc, EpochId: 2,
	})
	require.ErrorContains(t, err, "already open")
}

func TestOpenBeaconWindow_InvalidEpoch(t *testing.T) {
	acc, _, v := beaconValidator(t, 0x55)
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 5, []stakingtypes.Validator{v})

	_, err := ms.OpenBeaconWindow(ctx, &dealertypes.MsgOpenBeaconWindow{
		Caller: acc, EpochId: 0,
	})
	require.ErrorContains(t, err, "epoch_id")
}

// --- BeaconCommit ----------------------------------------------------------

// openBeaconFixture opens a beacon window rooted at the current block height
// and returns (bondedValidator, accAddr, valoperAddr). The harness is at
// block height 10 when this is used elsewhere unless overridden.
func openBeaconFixture(t *testing.T, ctx context.Context, ms dealertypes.MsgServer, acc string, epochID uint64, commitBlocks, revealBlocks uint64, threshold uint32) {
	t.Helper()
	_, err := ms.OpenBeaconWindow(ctx, &dealertypes.MsgOpenBeaconWindow{
		Caller:       acc,
		EpochId:      epochID,
		CommitBlocks: commitBlocks,
		RevealBlocks: revealBlocks,
		Threshold:    threshold,
	})
	require.NoError(t, err)
}

func TestBeaconCommit_HappyPath(t *testing.T) {
	acc, valoper, v := beaconValidator(t, 0x61)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	salt := bytes.Repeat([]byte{0x11}, 32)
	commitH, err := committee.Commit(valoper, 1, salt)
	require.NoError(t, err)

	_, err = ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{
		Validator: valoper,
		EpochId:   1,
		Commit:    commitH[:],
	})
	require.NoError(t, err)

	bs, err := k.GetBeaconState(ctx)
	require.NoError(t, err)
	require.Len(t, bs.Commits, 1)
	require.Equal(t, valoper, bs.Commits[0].Validator)
	require.Equal(t, commitH[:], bs.Commits[0].Commit)
}

func TestBeaconCommit_NonBondedRejected(t *testing.T) {
	// Set up a bonded validator whose seed is 0x71, then submit a commit
	// signed by an unrelated validator address (not in the bonded set).
	_, _, v := beaconValidator(t, 0x71)
	opener := sdk.AccAddress(bytes.Repeat([]byte{0x71}, 20)).String()
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, opener, 1, 5, 5, 1)

	// Fabricate a "validator" address with no bonded counterpart.
	attackerValoper := sdk.ValAddress(bytes.Repeat([]byte{0x88}, 20)).String()
	salt := bytes.Repeat([]byte{0x22}, 32)
	commitH, err := committee.Commit(attackerValoper, 1, salt)
	require.NoError(t, err)

	_, err = ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{
		Validator: attackerValoper,
		EpochId:   1,
		Commit:    commitH[:],
	})
	require.ErrorContains(t, err, "active bonded")
}

func TestBeaconCommit_WrongEpochRejected(t *testing.T) {
	acc, valoper, v := beaconValidator(t, 0x62)
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	salt := bytes.Repeat([]byte{0x12}, 32)
	commitH, err := committee.Commit(valoper, 1, salt)
	require.NoError(t, err)

	_, err = ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{
		Validator: valoper,
		EpochId:   2, // mismatch
		Commit:    commitH[:],
	})
	require.ErrorContains(t, err, "epoch_id")
}

func TestBeaconCommit_AfterCloseRejected(t *testing.T) {
	acc, valoper, v := beaconValidator(t, 0x63)
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	salt := bytes.Repeat([]byte{0x13}, 32)
	commitH, _ := committee.Commit(valoper, 1, salt)

	// Advance past commit close (10 + 5 = 15).
	ctxLate := beaconSetCtxHeight(ctx, 16)

	_, err := ms.BeaconCommit(ctxLate, &dealertypes.MsgBeaconCommit{
		Validator: valoper,
		EpochId:   1,
		Commit:    commitH[:],
	})
	require.ErrorContains(t, err, "commit window closed")
}

func TestBeaconCommit_DuplicateRejected(t *testing.T) {
	acc, valoper, v := beaconValidator(t, 0x64)
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	salt := bytes.Repeat([]byte{0x14}, 32)
	commitH, _ := committee.Commit(valoper, 1, salt)

	_, err := ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{
		Validator: valoper, EpochId: 1, Commit: commitH[:],
	})
	require.NoError(t, err)

	_, err = ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{
		Validator: valoper, EpochId: 1, Commit: commitH[:],
	})
	require.ErrorContains(t, err, "already submitted")
}

func TestBeaconCommit_WrongCommitLength(t *testing.T) {
	acc, valoper, v := beaconValidator(t, 0x65)
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	_, err := ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{
		Validator: valoper, EpochId: 1, Commit: bytes.Repeat([]byte{0x00}, 16),
	})
	require.ErrorContains(t, err, "32")
}

// --- BeaconReveal ----------------------------------------------------------

func TestBeaconReveal_HappyPath(t *testing.T) {
	acc, valoper, v := beaconValidator(t, 0x81)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	salt := bytes.Repeat([]byte{0x21}, 32)
	commitH, _ := committee.Commit(valoper, 1, salt)
	_, err := ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{Validator: valoper, EpochId: 1, Commit: commitH[:]})
	require.NoError(t, err)

	// Advance to reveal window (commit closes at 15).
	ctxReveal := beaconSetCtxHeight(ctx, 17)

	_, err = ms.BeaconReveal(ctxReveal, &dealertypes.MsgBeaconReveal{
		Validator: valoper,
		EpochId:   1,
		Salt:      salt,
	})
	require.NoError(t, err)

	bs, err := k.GetBeaconState(ctxReveal)
	require.NoError(t, err)
	require.Len(t, bs.Reveals, 1)
	require.Equal(t, salt, bs.Reveals[0].Salt)
}

func TestBeaconReveal_RevealWindowNotOpen(t *testing.T) {
	acc, valoper, v := beaconValidator(t, 0x82)
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	salt := bytes.Repeat([]byte{0x22}, 32)
	commitH, _ := committee.Commit(valoper, 1, salt)
	_, err := ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{Validator: valoper, EpochId: 1, Commit: commitH[:]})
	require.NoError(t, err)

	// Still inside the commit window — reveals forbidden (h <= commit_close).
	_, err = ms.BeaconReveal(ctx, &dealertypes.MsgBeaconReveal{
		Validator: valoper, EpochId: 1, Salt: salt,
	})
	require.ErrorContains(t, err, "reveal window not yet open")
}

func TestBeaconReveal_AfterCloseRejected(t *testing.T) {
	acc, valoper, v := beaconValidator(t, 0x83)
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	salt := bytes.Repeat([]byte{0x23}, 32)
	commitH, _ := committee.Commit(valoper, 1, salt)
	_, err := ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{Validator: valoper, EpochId: 1, Commit: commitH[:]})
	require.NoError(t, err)

	ctxLate := beaconSetCtxHeight(ctx, 21) // reveal_close = 15 + 5 = 20
	_, err = ms.BeaconReveal(ctxLate, &dealertypes.MsgBeaconReveal{
		Validator: valoper, EpochId: 1, Salt: salt,
	})
	require.ErrorContains(t, err, "reveal window closed")
}

func TestBeaconReveal_WrongSaltRejected(t *testing.T) {
	acc, valoper, v := beaconValidator(t, 0x84)
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	salt := bytes.Repeat([]byte{0x24}, 32)
	commitH, _ := committee.Commit(valoper, 1, salt)
	_, err := ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{Validator: valoper, EpochId: 1, Commit: commitH[:]})
	require.NoError(t, err)

	ctxReveal := beaconSetCtxHeight(ctx, 17)
	wrongSalt := bytes.Repeat([]byte{0x99}, 32)
	_, err = ms.BeaconReveal(ctxReveal, &dealertypes.MsgBeaconReveal{
		Validator: valoper, EpochId: 1, Salt: wrongSalt,
	})
	require.ErrorContains(t, err, "does not match")
}

func TestBeaconReveal_NoCommitRejected(t *testing.T) {
	// Validator is bonded and reveals during the window but never committed.
	acc, _, v1 := beaconValidator(t, 0x85)
	_, valoperB, v2 := beaconValidator(t, 0x86)
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v1, v2})

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	// Only v1 commits; v2 tries to reveal without committing.
	salt := bytes.Repeat([]byte{0x25}, 32)
	commitH, _ := committee.Commit(acc, 1, salt) // fake — but not used
	_ = commitH

	ctxReveal := beaconSetCtxHeight(ctx, 17)
	_, err := ms.BeaconReveal(ctxReveal, &dealertypes.MsgBeaconReveal{
		Validator: valoperB, EpochId: 1, Salt: salt,
	})
	require.ErrorContains(t, err, "no commit")
}

func TestBeaconReveal_NonBondedRejected(t *testing.T) {
	// Caller is NOT in the bonded set (symmetric with BeaconCommit's gate).
	_, _, v := beaconValidator(t, 0x87)
	opener := sdk.AccAddress(bytes.Repeat([]byte{0x87}, 20)).String()
	ctx, _, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})

	openBeaconFixture(t, ctx, ms, opener, 1, 5, 5, 1)

	ctxReveal := beaconSetCtxHeight(ctx, 17)
	attackerValoper := sdk.ValAddress(bytes.Repeat([]byte{0x77}, 20)).String()
	_, err := ms.BeaconReveal(ctxReveal, &dealertypes.MsgBeaconReveal{
		Validator: attackerValoper, EpochId: 1, Salt: bytes.Repeat([]byte{0x26}, 32),
	})
	require.ErrorContains(t, err, "active bonded")
}

// --- consumeBeaconForEpoch -------------------------------------------------
//
// consumeBeaconForEpoch is unexported and called from selectRandEpoch. These
// tests reach into it directly via msgServer{Keeper: k} so we don't also
// have to wire a full BeginEpoch integration harness.

func TestConsumeBeacon_HappyPath(t *testing.T) {
	acc, valoper, v := beaconValidator(t, 0x91)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})
	server := msgServer{Keeper: k}

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	salt := bytes.Repeat([]byte{0x31}, 32)
	commitH, _ := committee.Commit(valoper, 1, salt)
	_, err := ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{Validator: valoper, EpochId: 1, Commit: commitH[:]})
	require.NoError(t, err)

	ctxReveal := beaconSetCtxHeight(ctx, 17)
	_, err = ms.BeaconReveal(ctxReveal, &dealertypes.MsgBeaconReveal{Validator: valoper, EpochId: 1, Salt: salt})
	require.NoError(t, err)

	// Advance past reveal_close (= 15 + 5 = 20) and consume.
	ctxConsume := beaconSetCtxHeight(ctx, 21)
	final, err := server.consumeBeaconForEpoch(ctxConsume, 1, "ocp-prod-1")
	require.NoError(t, err)
	// Final is deterministic; just confirm it's non-zero.
	require.NotEqual(t, [32]byte{}, final)

	bs, err := k.GetBeaconState(ctxConsume)
	require.NoError(t, err)
	require.False(t, bs.Fallback)
	require.Equal(t, final[:], bs.Final)
}

func TestConsumeBeacon_FallbackOnDevnet(t *testing.T) {
	_, _, v := beaconValidator(t, 0x92)
	ctx, k, _, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})
	server := msgServer{Keeper: k}

	// No beacon state exists. Devnet chain id should fall back silently.
	final, err := server.consumeBeaconForEpoch(ctx, 1, "ocp-devnet-1")
	require.NoError(t, err)
	require.NotEqual(t, [32]byte{}, final)
}

func TestConsumeBeacon_RefusesOnProductionWithoutState(t *testing.T) {
	_, _, v := beaconValidator(t, 0x93)
	ctx, k, _, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})
	server := msgServer{Keeper: k}

	_, err := server.consumeBeaconForEpoch(ctx, 1, "ocp-prod-1")
	require.ErrorContains(t, err, "beacon state missing")
}

func TestConsumeBeacon_FallbackOnBelowThresholdDevnet(t *testing.T) {
	acc, _, v := beaconValidator(t, 0x94)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})
	server := msgServer{Keeper: k}

	// threshold=2 but no reveals → below threshold.
	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 2)

	ctxConsume := beaconSetCtxHeight(ctx, 21)
	final, err := server.consumeBeaconForEpoch(ctxConsume, 1, "ocp-devnet-1")
	require.NoError(t, err)
	require.NotEqual(t, [32]byte{}, final)

	bs, err := k.GetBeaconState(ctxConsume)
	require.NoError(t, err)
	require.True(t, bs.Fallback)
}

func TestConsumeBeacon_RefusesOnProductionBelowThreshold(t *testing.T) {
	acc, _, v := beaconValidator(t, 0x95)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})
	server := msgServer{Keeper: k}

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 2) // threshold=2, 0 reveals

	ctxConsume := beaconSetCtxHeight(ctx, 21)
	_, err := server.consumeBeaconForEpoch(ctxConsume, 1, "ocp-prod-1")
	require.ErrorContains(t, err, "below threshold")
}

func TestConsumeBeacon_RevealWindowStillOpen(t *testing.T) {
	acc, _, v := beaconValidator(t, 0x96)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v})
	server := msgServer{Keeper: k}

	openBeaconFixture(t, ctx, ms, acc, 1, 5, 5, 1)

	// Consume while reveal window is still open (height 17 < reveal_close=20).
	ctxEarly := beaconSetCtxHeight(ctx, 17)
	_, err := server.consumeBeaconForEpoch(ctxEarly, 1, "ocp-prod-1")
	require.ErrorContains(t, err, "still open")
}

func TestConsumeBeacon_SlashesCommittedButNotRevealed(t *testing.T) {
	// v1 commits + reveals; v2 commits but does NOT reveal. v2 should be
	// slashed at consume time.
	acc1, valoper1, v1 := beaconValidator(t, 0x97)
	_, valoper2, v2 := beaconValidator(t, 0x98)
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, []stakingtypes.Validator{v1, v2})
	server := msgServer{Keeper: k}

	openBeaconFixture(t, ctx, ms, acc1, 1, 5, 5, 1)

	s1 := bytes.Repeat([]byte{0x41}, 32)
	c1, _ := committee.Commit(valoper1, 1, s1)
	_, err := ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{Validator: valoper1, EpochId: 1, Commit: c1[:]})
	require.NoError(t, err)

	s2 := bytes.Repeat([]byte{0x42}, 32)
	c2, _ := committee.Commit(valoper2, 1, s2)
	_, err = ms.BeaconCommit(ctx, &dealertypes.MsgBeaconCommit{Validator: valoper2, EpochId: 1, Commit: c2[:]})
	require.NoError(t, err)

	ctxReveal := beaconSetCtxHeight(ctx, 17)
	_, err = ms.BeaconReveal(ctxReveal, &dealertypes.MsgBeaconReveal{Validator: valoper1, EpochId: 1, Salt: s1})
	require.NoError(t, err)

	ctxConsume := beaconSetCtxHeight(ctx, 21)
	sdkCtx := sdk.UnwrapSDKContext(ctxConsume).WithEventManager(sdk.NewEventManager())
	ctxConsume = sdk.WrapSDKContext(sdkCtx)

	final, err := server.consumeBeaconForEpoch(ctxConsume, 1, "ocp-prod-1")
	require.NoError(t, err)
	require.NotEqual(t, [32]byte{}, final)

	// Inspect events: exactly one ValidatorSlashed event naming valoper2.
	slashed := 0
	for _, ev := range sdkCtx.EventManager().Events() {
		if ev.Type != dealertypes.EventTypeValidatorSlashed {
			continue
		}
		for _, attr := range ev.Attributes {
			if attr.Key == "validator" && attr.Value == valoper2 {
				slashed++
			}
		}
	}
	require.Equal(t, 1, slashed, "expected valoper2 to be slashed exactly once")
}
