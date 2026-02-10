package keeper

import (
	"bytes"
	"testing"
	"time"

	storetypes "cosmossdk.io/store/types"

	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/testutil"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

func newParamsKeeper(t *testing.T) (sdk.Context, Keeper) {
	t.Helper()

	key := storetypes.NewKVStoreKey(dealertypes.StoreKey)
	storeService := runtime.NewKVStoreService(key)
	testCtx := testutil.DefaultContextWithDB(t, key, storetypes.NewTransientStoreKey("transient_test"))

	sdkCtx := testCtx.Ctx.WithEventManager(sdk.NewEventManager()).WithBlockTime(time.Unix(100, 0).UTC())

	ir := codectypes.NewInterfaceRegistry()
	cdc := codec.NewProtoCodec(ir)

	auth := sdk.AccAddress(bytes.Repeat([]byte{0x11}, 20)).String()
	k := Keeper{
		storeService: storeService,
		cdc:          cdc,
		authority:    auth,
	}

	return sdkCtx, k
}

func TestKeeperParams_DefaultsWhenUnset(t *testing.T) {
	sdkCtx, k := newParamsKeeper(t)
	ctx := sdk.WrapSDKContext(sdkCtx)

	p, err := k.GetParams(ctx)
	require.NoError(t, err)
	require.Equal(t, dealertypes.DefaultParams(), p)
}

func TestKeeperParams_SetGetRoundTrip(t *testing.T) {
	sdkCtx, k := newParamsKeeper(t)
	ctx := sdk.WrapSDKContext(sdkCtx)

	want := dealertypes.Params{
		SlashBpsDkg:           1234,
		SlashBpsHandDealer:    567,
		JailSecondsDkg:        12,
		JailSecondsHandDealer: 34,
	}
	require.NoError(t, k.SetParams(ctx, want))

	got, err := k.GetParams(ctx)
	require.NoError(t, err)
	require.Equal(t, want, got)
}

func TestMsgUpdateParams_Unauthorized(t *testing.T) {
	sdkCtx, k := newParamsKeeper(t)
	ctx := sdk.WrapSDKContext(sdkCtx)

	ms := msgServer{Keeper: k}

	badAuth := sdk.AccAddress(bytes.Repeat([]byte{0x22}, 20)).String()
	_, err := ms.UpdateParams(ctx, &dealertypes.MsgUpdateParams{
		Authority: badAuth,
		Params:    dealertypes.DefaultParams(),
	})
	require.Error(t, err)
	require.ErrorIs(t, err, dealertypes.ErrUnauthorized)
}

func TestMsgUpdateParams_SetsParams(t *testing.T) {
	sdkCtx, k := newParamsKeeper(t)
	ctx := sdk.WrapSDKContext(sdkCtx)

	ms := msgServer{Keeper: k}

	next := dealertypes.Params{
		SlashBpsDkg:           500,
		SlashBpsHandDealer:    250,
		JailSecondsDkg:        0,
		JailSecondsHandDealer: 10,
	}
	_, err := ms.UpdateParams(ctx, &dealertypes.MsgUpdateParams{
		Authority: k.Authority(),
		Params:    next,
	})
	require.NoError(t, err)

	got, err := k.GetParams(ctx)
	require.NoError(t, err)
	require.Equal(t, next, got)
}

func TestMsgUpdateParams_RejectsInvalidParams(t *testing.T) {
	sdkCtx, k := newParamsKeeper(t)
	ctx := sdk.WrapSDKContext(sdkCtx)

	ms := msgServer{Keeper: k}

	_, err := ms.UpdateParams(ctx, &dealertypes.MsgUpdateParams{
		Authority: k.Authority(),
		Params: dealertypes.Params{
			SlashBpsDkg:        dealertypes.MaxBps + 1,
			SlashBpsHandDealer: 0,
		},
	})
	require.Error(t, err)
}
