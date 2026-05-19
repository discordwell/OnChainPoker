package keeper_test

import (
	"crypto/sha256"
	"testing"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"onchainpoker/apps/cosmos/x/poker/keeper"
	"onchainpoker/apps/cosmos/x/poker/types"
)

// TestMigrate1to2_NoopOnEmptyKeeper verifies the migration runs cleanly on a
// keeper with no tables. The v1->v2 schema bump is proto3-additive, so the
// migration is informational only; this test guards against future
// regressions where the migration accidentally starts doing destructive work.
func TestMigrate1to2_NoopOnEmptyKeeper(t *testing.T) {
	sdkCtx, k, _, _ := newKeeper(t, time.Unix(100, 0).UTC())
	mgr := keeper.NewMigrator(k)
	require.NoError(t, mgr.Migrate1to2(sdkCtx))
}

// TestMigrate1to2_PreservesPasswordHash plants a legacy table (unsalted hash,
// empty salt) and confirms the migration leaves its fields untouched —
// crucial for the dual-path compatibility (see TestSitPasswordLegacyTableBitCompat).
func TestMigrate1to2_PreservesPasswordHash(t *testing.T) {
	sdkCtx, k, _, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	legacyHash := sha256.Sum256([]byte("legacy-pw"))
	tbl := &types.Table{
		Id:      1,
		Creator: addr(0xC1).String(),
		Label:   "legacy",
		Params: types.TableParams{
			MaxPlayers:   9,
			SmallBlind:   1,
			BigBlind:     2,
			MinBuyIn:     100,
			MaxBuyIn:     1000,
			PasswordHash: legacyHash[:],
			PasswordSalt: nil,
		},
		Seats:      make([]*types.Seat, 9),
		NextHandId: 1,
		ButtonSeat: -1,
	}
	require.NoError(t, k.SetTable(ctx, tbl))
	require.NoError(t, k.SetNextTableID(ctx, 2))

	mgr := keeper.NewMigrator(k)
	require.NoError(t, mgr.Migrate1to2(sdkCtx))

	got, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Equal(t, legacyHash[:], got.Params.PasswordHash, "password_hash must be preserved")
	require.Empty(t, got.Params.PasswordSalt, "legacy salt stays empty")
}
