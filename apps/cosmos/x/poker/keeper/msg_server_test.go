package keeper_test

import (
	"bytes"
	"context"
	"math"
	"testing"
	"time"

	sdkmath "cosmossdk.io/math"
	storetypes "cosmossdk.io/store/types"

	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/testutil"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	"github.com/stretchr/testify/require"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
	"onchainpoker/apps/cosmos/x/poker/keeper"
	"onchainpoker/apps/cosmos/x/poker/types"
)

type bankCall struct {
	kind string // a2m, m2a, m2m

	fromAcc sdk.AccAddress
	toAcc   sdk.AccAddress

	fromModule string
	toModule   string

	coins sdk.Coins
}

type fakeBankKeeper struct {
	calls []bankCall
}

func (b *fakeBankKeeper) SendCoinsFromAccountToModule(ctx context.Context, senderAddr sdk.AccAddress, recipientModule string, amt sdk.Coins) error {
	_ = ctx
	b.calls = append(b.calls, bankCall{
		kind:     "a2m",
		fromAcc:  senderAddr,
		toModule: recipientModule,
		coins:    amt,
	})
	return nil
}

func (b *fakeBankKeeper) SendCoinsFromModuleToAccount(ctx context.Context, senderModule string, recipientAddr sdk.AccAddress, amt sdk.Coins) error {
	_ = ctx
	b.calls = append(b.calls, bankCall{
		kind:       "m2a",
		fromModule: senderModule,
		toAcc:      recipientAddr,
		coins:      amt,
	})
	return nil
}

func (b *fakeBankKeeper) SendCoinsFromModuleToModule(ctx context.Context, senderModule string, recipientModule string, amt sdk.Coins) error {
	_ = ctx
	b.calls = append(b.calls, bankCall{
		kind:       "m2m",
		fromModule: senderModule,
		toModule:   recipientModule,
		coins:      amt,
	})
	return nil
}

func addr(b byte) sdk.AccAddress {
	return sdk.AccAddress(bytes.Repeat([]byte{b}, 20))
}

func newKeeper(t *testing.T, blockTime time.Time) (sdk.Context, keeper.Keeper, types.MsgServer, *fakeBankKeeper) {
	t.Helper()

	key := storetypes.NewKVStoreKey(types.StoreKey)
	storeService := runtime.NewKVStoreService(key)
	testCtx := testutil.DefaultContextWithDB(t, key, storetypes.NewTransientStoreKey("transient_test"))

	sdkCtx := testCtx.Ctx.WithEventManager(sdk.NewEventManager()).WithBlockTime(blockTime)

	ir := codectypes.NewInterfaceRegistry()
	cdc := codec.NewProtoCodec(ir)

	bk := &fakeBankKeeper{}
	k := keeper.NewKeeper(cdc, storeService, bk)
	ms := keeper.NewMsgServerImpl(k, cdc)

	return sdkCtx, k, ms, bk
}

func TestCreateTable_NormalizesSeats(t *testing.T) {
	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)
	creator := addr(0x01).String()

	resp, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:           creator,
		SmallBlind:        1,
		BigBlind:          2,
		MinBuyIn:          100,
		MaxBuyIn:          1000,
		ActionTimeoutSecs: 0,
		DealerTimeoutSecs: 0,
		PlayerBond:        0,
		RakeBps:           0,
		MaxPlayers:        9,
		Label:             "test",
	})
	require.NoError(t, err)
	require.Equal(t, uint64(1), resp.TableId)

	tbl, err := k.GetTable(ctx, resp.TableId)
	require.NoError(t, err)
	require.NotNil(t, tbl)
	require.Len(t, tbl.Seats, 9)
	for i := 0; i < 9; i++ {
		require.NotNil(t, tbl.Seats[i], "seat %d should not be nil", i)
		require.Empty(t, tbl.Seats[i].Player)
	}
}

func TestSitLeave_EscrowAndReturnCoins(t *testing.T) {
	oldDenom := sdk.DefaultBondDenom
	sdk.DefaultBondDenom = "uocp"
	defer func() { sdk.DefaultBondDenom = oldDenom }()

	sdkCtx, k, ms, bk := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	playerAcc := addr(0x02)
	player := playerAcc.String()

	// Valid pk_player.
	pkBytes := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:           player,
		SmallBlind:        1,
		BigBlind:          2,
		MinBuyIn:          100,
		MaxBuyIn:          1000,
		ActionTimeoutSecs: 0,
		DealerTimeoutSecs: 0,
		PlayerBond:        7,
		RakeBps:           0,
		MaxPlayers:        9,
		Label:             "escrow",
	})
	require.NoError(t, err)

	_, err = ms.Sit(ctx, &types.MsgSit{
		Player:   player,
		TableId:  1,
		Seat:     0,
		BuyIn:    100,
		PkPlayer: pkBytes,
	})
	require.NoError(t, err)

	require.Len(t, bk.calls, 1)
	require.Equal(t, "a2m", bk.calls[0].kind)
	require.Equal(t, playerAcc, bk.calls[0].fromAcc)
	require.Equal(t, types.ModuleName, bk.calls[0].toModule)
	require.Equal(t, sdk.NewCoins(sdk.NewCoin("uocp", sdkmath.NewInt(107))), bk.calls[0].coins)

	tbl, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, tbl)
	require.Equal(t, player, tbl.Seats[0].Player)
	require.Equal(t, uint64(100), tbl.Seats[0].Stack)
	require.Equal(t, uint64(7), tbl.Seats[0].Bond)

	_, err = ms.Leave(ctx, &types.MsgLeave{
		Player:  player,
		TableId: 1,
	})
	require.NoError(t, err)

	require.Len(t, bk.calls, 2)
	require.Equal(t, "m2a", bk.calls[1].kind)
	require.Equal(t, types.ModuleName, bk.calls[1].fromModule)
	require.Equal(t, playerAcc, bk.calls[1].toAcc)
	require.Equal(t, sdk.NewCoins(sdk.NewCoin("uocp", sdkmath.NewInt(107))), bk.calls[1].coins)

	tbl2, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, tbl2)
	require.Empty(t, tbl2.Seats[0].Player)
	require.Zero(t, tbl2.Seats[0].Stack)
	require.Zero(t, tbl2.Seats[0].Bond)
}

func TestTick_SlashesBondAndMovesCoinsToFeeCollector(t *testing.T) {
	oldDenom := sdk.DefaultBondDenom
	sdk.DefaultBondDenom = "uocp"
	defer func() { sdk.DefaultBondDenom = oldDenom }()

	now := time.Unix(100, 0).UTC()
	sdkCtx, k, ms, bk := newKeeper(t, now)
	ctx := sdk.WrapSDKContext(sdkCtx)

	p0 := addr(0x10)
	p1 := addr(0x11)

	tbl := &types.Table{
		Id:      1,
		Creator: p0.String(),
		Label:   "tick",
		Params: types.TableParams{
			MaxPlayers:        9,
			SmallBlind:        1,
			BigBlind:          5,
			MinBuyIn:          1,
			MaxBuyIn:          1000,
			ActionTimeoutSecs: 0,
			DealerTimeoutSecs: 0,
			PlayerBond:        10,
			RakeBps:           0,
		},
		Seats:      make([]*types.Seat, 9),
		NextHandId: 2,
		ButtonSeat: -1,
		Hand: &types.Hand{
			HandId:     1,
			Phase:      types.HandPhase_HAND_PHASE_BETTING,
			Street:     types.Street_STREET_PREFLOP,
			ActionOn:   0,
			BetTo:      0,
			IntervalId: 0,

			InHand:            make([]bool, 9),
			Folded:            make([]bool, 9),
			AllIn:             make([]bool, 9),
			StreetCommit:      make([]uint64, 9),
			TotalCommit:       make([]uint64, 9),
			LastIntervalActed: make([]int32, 9),

			ActionDeadline: now.Unix() - 1,
		},
	}
	for i := 0; i < 9; i++ {
		tbl.Hand.LastIntervalActed[i] = -1
	}
	tbl.Hand.InHand[0] = true
	tbl.Hand.InHand[1] = true

	tbl.Seats[0] = &types.Seat{Player: p0.String(), Stack: 100, Bond: 10, Hole: []uint32{255, 255}}
	tbl.Seats[1] = &types.Seat{Player: p1.String(), Stack: 100, Bond: 10, Hole: []uint32{255, 255}}

	require.NoError(t, k.SetTable(ctx, tbl))

	_, err := ms.Tick(ctx, &types.MsgTick{Caller: p0.String(), TableId: 1})
	require.NoError(t, err)

	require.Len(t, bk.calls, 1)
	require.Equal(t, "m2m", bk.calls[0].kind)
	require.Equal(t, types.ModuleName, bk.calls[0].fromModule)
	require.Equal(t, authtypes.FeeCollectorName, bk.calls[0].toModule)
	require.Equal(t, sdk.NewCoins(sdk.NewCoin("uocp", sdkmath.NewInt(5))), bk.calls[0].coins)

	tbl2, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, tbl2)
	require.Equal(t, uint64(5), tbl2.Seats[0].Bond)
}

func TestCreateTable_RejectsHugeTimeoutInputs(t *testing.T) {
	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)
	creator := addr(0x20).String()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:           creator,
		SmallBlind:        1,
		BigBlind:          2,
		MinBuyIn:          100,
		MaxBuyIn:          1000,
		ActionTimeoutSecs: ^uint64(0),
		DealerTimeoutSecs: 0,
		PlayerBond:        0,
		RakeBps:           0,
		MaxPlayers:        9,
		Label:             "huge-action-timeout",
	})
	require.ErrorContains(t, err, "action_timeout_secs exceeds int64 max")
	next, getErr := k.GetNextTableID(ctx)
	require.NoError(t, getErr)
	require.Equal(t, uint64(1), next)

	_, err = ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:           creator,
		SmallBlind:        1,
		BigBlind:          2,
		MinBuyIn:          100,
		MaxBuyIn:          1000,
		ActionTimeoutSecs: 0,
		DealerTimeoutSecs: ^uint64(0),
		PlayerBond:        0,
		RakeBps:           0,
		MaxPlayers:        9,
		Label:             "huge-dealer-timeout",
	})
	require.ErrorContains(t, err, "dealer_timeout_secs exceeds int64 max")
	next, getErr = k.GetNextTableID(ctx)
	require.NoError(t, getErr)
	require.Equal(t, uint64(1), next)
}

func TestCreateTable_NextTableIDOverflow(t *testing.T) {
	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)
	creator := addr(0x21).String()

	require.NoError(t, k.SetNextTableID(ctx, ^uint64(0)))

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:           creator,
		SmallBlind:        1,
		BigBlind:          2,
		MinBuyIn:          100,
		MaxBuyIn:          1000,
		ActionTimeoutSecs: 0,
		DealerTimeoutSecs: 0,
		PlayerBond:        0,
		RakeBps:           0,
		MaxPlayers:        9,
		Label:             "overflow",
	})
	require.ErrorContains(t, err, "next table id overflows uint64")

	next, getErr := k.GetNextTableID(ctx)
	require.NoError(t, getErr)
	require.Equal(t, ^uint64(0), next)
}

func TestStartHand_NextHandIDOverflow(t *testing.T) {
	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	p0 := addr(0x31).String()
	p1 := addr(0x32).String()
	pkBytes := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:           p0,
		SmallBlind:        1,
		BigBlind:          2,
		MinBuyIn:          100,
		MaxBuyIn:          1000,
		ActionTimeoutSecs: 0,
		DealerTimeoutSecs: 0,
		PlayerBond:        0,
		RakeBps:           0,
		MaxPlayers:        9,
		Label:             "hand-overflow",
	})
	require.NoError(t, err)
	_, err = ms.Sit(ctx, &types.MsgSit{Player: p0, TableId: 1, Seat: 0, BuyIn: 100, PkPlayer: pkBytes})
	require.NoError(t, err)
	_, err = ms.Sit(ctx, &types.MsgSit{Player: p1, TableId: 1, Seat: 1, BuyIn: 100, PkPlayer: pkBytes})
	require.NoError(t, err)

	tbl, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, tbl)
	tbl.NextHandId = ^uint64(0)
	require.NoError(t, k.SetTable(ctx, tbl))

	_, err = ms.StartHand(ctx, &types.MsgStartHand{Caller: p0, TableId: 1})
	require.ErrorContains(t, err, "next hand id overflows uint64")

	tbl2, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, tbl2)
	require.Equal(t, ^uint64(0), tbl2.NextHandId)
	require.Nil(t, tbl2.Hand)
}

func TestTick_HugeActionTimeoutOverflowDoesNotMutate(t *testing.T) {
	now := time.Unix(math.MaxInt64, 0).UTC()
	sdkCtx, k, ms, _ := newKeeper(t, now)
	ctx := sdk.WrapSDKContext(sdkCtx)

	p0 := addr(0x41)
	p1 := addr(0x42)

	tbl := &types.Table{
		Id:      1,
		Creator: p0.String(),
		Label:   "tick-overflow",
		Params: types.TableParams{
			MaxPlayers:        9,
			SmallBlind:        1,
			BigBlind:          2,
			MinBuyIn:          1,
			MaxBuyIn:          1000,
			ActionTimeoutSecs: 1,
			DealerTimeoutSecs: 0,
			PlayerBond:        0,
			RakeBps:           0,
		},
		Seats:      make([]*types.Seat, 9),
		NextHandId: 2,
		ButtonSeat: -1,
		Hand: &types.Hand{
			HandId:       1,
			Phase:        types.HandPhase_HAND_PHASE_BETTING,
			Street:       types.Street_STREET_PREFLOP,
			ActionOn:     0,
			BetTo:        0,
			IntervalId:   0,
			InHand:       make([]bool, 9),
			Folded:       make([]bool, 9),
			AllIn:        make([]bool, 9),
			StreetCommit: make([]uint64, 9),
			TotalCommit:  make([]uint64, 9),
			LastIntervalActed: []int32{
				-1, -1, -1, -1, -1, -1, -1, -1, -1,
			},
			ActionDeadline: 0,
		},
	}
	tbl.Hand.InHand[0] = true
	tbl.Hand.InHand[1] = true
	tbl.Seats[0] = &types.Seat{Player: p0.String(), Stack: 100, Bond: 0, Hole: []uint32{255, 255}}
	tbl.Seats[1] = &types.Seat{Player: p1.String(), Stack: 100, Bond: 0, Hole: []uint32{255, 255}}
	require.NoError(t, k.SetTable(ctx, tbl))

	_, err := ms.Tick(ctx, &types.MsgTick{Caller: p0.String(), TableId: 1})
	require.ErrorContains(t, err, "action deadline overflows int64")

	tbl2, getErr := k.GetTable(ctx, 1)
	require.NoError(t, getErr)
	require.NotNil(t, tbl2)
	require.NotNil(t, tbl2.Hand)
	require.Equal(t, int64(0), tbl2.Hand.ActionDeadline)
}
