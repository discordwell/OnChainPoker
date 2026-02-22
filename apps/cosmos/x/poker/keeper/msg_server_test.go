package keeper_test

import (
	"bytes"
	"context"
	"crypto/sha256"
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

func TestCreateTable_RejectsNonZeroRake(t *testing.T) {
	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)
	creator := addr(0x51).String()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:           creator,
		SmallBlind:        1,
		BigBlind:          2,
		MinBuyIn:          100,
		MaxBuyIn:          1000,
		ActionTimeoutSecs: 0,
		DealerTimeoutSecs: 0,
		PlayerBond:        0,
		RakeBps:           1,
		MaxPlayers:        9,
		Label:             "non-zero-rake",
	})
	require.ErrorContains(t, err, "rake_bps must be 0")

	next, getErr := k.GetNextTableID(ctx)
	require.NoError(t, getErr)
	require.Equal(t, uint64(1), next)
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
	_, err = ms.Sit(ctx, &types.MsgSit{Player: p0, TableId: 1, BuyIn: 100, PkPlayer: pkBytes})
	require.NoError(t, err)
	_, err = ms.Sit(ctx, &types.MsgSit{Player: p1, TableId: 1, BuyIn: 100, PkPlayer: pkBytes})
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

// ---------------------------------------------------------------------------
// Hand‑flow integration tests
// ---------------------------------------------------------------------------

// setupHeadsUpBetting creates a table with two seated players and constructs
// a hand state directly in the BETTING phase with Dealer: nil (bypassing the
// shuffle protocol) so that betting/fold/check/call logic can be exercised.
// Blinds: SB=1, BB=2. P0 at seat 0 (SB/Button), P1 at seat 1 (BB).
// ActionOn starts at seat 0 (UTG in heads-up = button/SB, first to act preflop).
func setupHeadsUpBetting(t *testing.T, now time.Time) (sdk.Context, keeper.Keeper, types.MsgServer, *fakeBankKeeper, sdk.AccAddress, sdk.AccAddress) {
	t.Helper()

	sdkCtx, k, ms, bk := newKeeper(t, now)
	ctx := sdk.WrapSDKContext(sdkCtx)

	p0 := addr(0xA0)
	p1 := addr(0xA1)

	tbl := &types.Table{
		Id:      1,
		Creator: p0.String(),
		Label:   "heads-up-test",
		Params: types.TableParams{
			MaxPlayers:        9,
			SmallBlind:        1,
			BigBlind:          2,
			MinBuyIn:          100,
			MaxBuyIn:          1000,
			ActionTimeoutSecs: 0,
			DealerTimeoutSecs: 0,
			PlayerBond:        0,
			RakeBps:           0,
		},
		Seats:      make([]*types.Seat, 9),
		NextHandId: 2,
		ButtonSeat: 0,
		Hand: &types.Hand{
			HandId:         1,
			Phase:          types.HandPhase_HAND_PHASE_BETTING,
			Street:         types.Street_STREET_PREFLOP,
			ButtonSeat:     0,
			SmallBlindSeat: 0,
			BigBlindSeat:   1,
			ActionOn:       0, // SB/Button acts first preflop in heads-up
			BetTo:          2,
			MinRaiseSize:   2,
			IntervalId:     0,
			Dealer:         nil, // No dealer: pure betting tests

			InHand:            make([]bool, 9),
			Folded:            make([]bool, 9),
			AllIn:             make([]bool, 9),
			StreetCommit:      make([]uint64, 9),
			TotalCommit:       make([]uint64, 9),
			LastIntervalActed: make([]int32, 9),
			Board:             nil,
			ActionDeadline:    0,
		},
	}
	for i := 0; i < 9; i++ {
		tbl.Hand.LastIntervalActed[i] = -1
	}

	tbl.Hand.InHand[0] = true
	tbl.Hand.InHand[1] = true

	// Post blinds: P0 posts SB=1, P1 posts BB=2
	tbl.Seats[0] = &types.Seat{Player: p0.String(), Stack: 99, Bond: 0, Hole: []uint32{255, 255}}
	tbl.Hand.StreetCommit[0] = 1
	tbl.Hand.TotalCommit[0] = 1

	tbl.Seats[1] = &types.Seat{Player: p1.String(), Stack: 98, Bond: 0, Hole: []uint32{255, 255}}
	tbl.Hand.StreetCommit[1] = 2
	tbl.Hand.TotalCommit[1] = 2

	require.NoError(t, k.SetTable(ctx, tbl))

	return sdkCtx, k, ms, bk, p0, p1
}

func TestHeadsUpAllFold(t *testing.T) {
	sdkCtx, k, ms, _, p0, _ := setupHeadsUpBetting(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	// P0 (seat 0, actionOn) folds preflop → P1 wins.
	_, err := ms.Act(ctx, &types.MsgAct{
		Player:  p0.String(),
		TableId: 1,
		Action:  "fold",
		Amount:  0,
	})
	require.NoError(t, err)

	tbl, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, tbl)
	require.Nil(t, tbl.Hand, "hand should be cleared after all-fold")

	// P1 (seat 1) should have won the pot (SB=1 + BB=2 = 3).
	// P1 started with 98 stack, blind 2 already deducted, so final = 98 + 3 = 101.
	require.Equal(t, uint64(101), tbl.Seats[1].Stack, "P1 should win the pot")
	// P0 folded, stack unchanged from post-blind state (99).
	require.Equal(t, uint64(99), tbl.Seats[0].Stack, "P0 stack unchanged after fold")
}

func TestHeadsUpCallCheck(t *testing.T) {
	sdkCtx, k, ms, _, p0, p1 := setupHeadsUpBetting(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	// P0 (seat 0) calls the BB (needs 1 more to match BetTo=2).
	_, err := ms.Act(ctx, &types.MsgAct{
		Player:  p0.String(),
		TableId: 1,
		Action:  "call",
		Amount:  0,
	})
	require.NoError(t, err)

	tbl, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, tbl)
	require.NotNil(t, tbl.Hand, "hand should still be active after call")
	require.Equal(t, int32(1), tbl.Hand.ActionOn, "action should move to P1 (seat 1)")

	// P1 (seat 1, BB) checks.
	_, err = ms.Act(ctx, &types.MsgAct{
		Player:  p1.String(),
		TableId: 1,
		Action:  "check",
		Amount:  0,
	})
	require.NoError(t, err)

	// With Dealer: nil, maybeAdvance returns nil at end of street (no street transition).
	// The hand remains active but street is complete.
	tbl2, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, tbl2)
	// Hand stays active (no dealer to deal next street).
	require.NotNil(t, tbl2.Hand, "hand should remain with no dealer")
	// Both players should have committed 2 each.
	require.Equal(t, uint64(2), tbl2.Hand.StreetCommit[0])
	require.Equal(t, uint64(2), tbl2.Hand.StreetCommit[1])
}

func TestActRejectsWrongPlayer(t *testing.T) {
	sdkCtx, _, ms, _, _, p1 := setupHeadsUpBetting(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	// P1 (seat 1) tries to act, but actionOn is seat 0 (P0).
	_, err := ms.Act(ctx, &types.MsgAct{
		Player:  p1.String(),
		TableId: 1,
		Action:  "check",
		Amount:  0,
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "not your turn")
}

func TestLeaveRejectsDuringHand(t *testing.T) {
	sdkCtx, _, ms, _, p0, _ := setupHeadsUpBetting(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	// P0 is in an active hand (InHand[0] = true). Leave should be rejected.
	_, err := ms.Leave(ctx, &types.MsgLeave{
		Player:  p0.String(),
		TableId: 1,
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "cannot leave during active hand")
}

func TestHeadsUpFoldAfterRaise(t *testing.T) {
	sdkCtx, k, ms, _, p0, p1 := setupHeadsUpBetting(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	// P0 (seat 0) raises to 6 (BetTo was 2, raise size = 4 >= minRaise=2).
	_, err := ms.Act(ctx, &types.MsgAct{
		Player:  p0.String(),
		TableId: 1,
		Action:  "raise",
		Amount:  6,
	})
	require.NoError(t, err)

	tbl, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, tbl.Hand)
	require.Equal(t, int32(1), tbl.Hand.ActionOn, "action should move to P1")
	require.Equal(t, uint64(6), tbl.Hand.BetTo)

	// P1 (seat 1) folds → P0 wins.
	_, err = ms.Act(ctx, &types.MsgAct{
		Player:  p1.String(),
		TableId: 1,
		Action:  "fold",
		Amount:  0,
	})
	require.NoError(t, err)

	tbl2, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.Nil(t, tbl2.Hand, "hand should be cleared")

	// P0 raised to 6 (committed 6), P1 had BB=2 committed. Pot = 6 + 2 = 8.
	// But uncalled excess is returned: P0 committed 6, P1 committed 2, excess = 4 returned to P0.
	// So P0 wins pot = 2 + 2 = 4 (after excess return).
	// P0 started with 99. Posted SB=1, then raised 5 more (to 6 total). Stack before win = 94.
	// Excess of 4 returned, then pot of 4 awarded: P0 = 94 + 4 + 4 = 102.
	// Actually let me recalculate: P0 started with stack=99 (after SB=1 posted).
	// Raise to 6 means 5 more chips from stack (already committed 1). Stack = 99 - 5 = 94.
	// P1 folds. Uncalled excess: P0 committed 6, second max = P1's 2. Excess = 4 returned.
	// P0 stack after excess return = 94 + 4 = 98.
	// Pot after return: P0 commit = 2, P1 commit = 2. Total pot = 4.
	// P0 wins pot: 98 + 4 = 102.
	require.Equal(t, uint64(102), tbl2.Seats[0].Stack, "P0 should win pot after P1 folds")
	require.Equal(t, uint64(98), tbl2.Seats[1].Stack, "P1 stack unchanged after fold")
}

func TestAllInCall(t *testing.T) {
	now := time.Unix(100, 0).UTC()
	sdkCtx, k, ms, _ := newKeeper(t, now)
	ctx := sdk.WrapSDKContext(sdkCtx)

	p0 := addr(0xB0)
	p1 := addr(0xB1)

	// P0 has only 1 chip (less than BB=2), will be all-in from SB posting.
	tbl := &types.Table{
		Id:      1,
		Creator: p0.String(),
		Label:   "allin-test",
		Params: types.TableParams{
			MaxPlayers:        9,
			SmallBlind:        1,
			BigBlind:          2,
			MinBuyIn:          1,
			MaxBuyIn:          1000,
			ActionTimeoutSecs: 0,
			DealerTimeoutSecs: 0,
			PlayerBond:        0,
			RakeBps:           0,
		},
		Seats:      make([]*types.Seat, 9),
		NextHandId: 2,
		ButtonSeat: 0,
		Hand: &types.Hand{
			HandId:         1,
			Phase:          types.HandPhase_HAND_PHASE_BETTING,
			Street:         types.Street_STREET_PREFLOP,
			ButtonSeat:     0,
			SmallBlindSeat: 0,
			BigBlindSeat:   1,
			ActionOn:       1, // P1 (BB) to act since P0 is all-in
			BetTo:          2,
			MinRaiseSize:   2,
			IntervalId:     0,
			Dealer:         nil,

			InHand:            make([]bool, 9),
			Folded:            make([]bool, 9),
			AllIn:             make([]bool, 9),
			StreetCommit:      make([]uint64, 9),
			TotalCommit:       make([]uint64, 9),
			LastIntervalActed: make([]int32, 9),
			Board:             nil,
			ActionDeadline:    0,
		},
	}
	for i := 0; i < 9; i++ {
		tbl.Hand.LastIntervalActed[i] = -1
	}

	tbl.Hand.InHand[0] = true
	tbl.Hand.InHand[1] = true
	tbl.Hand.AllIn[0] = true // P0 is all-in from blind posting

	tbl.Seats[0] = &types.Seat{Player: p0.String(), Stack: 0, Bond: 0, Hole: []uint32{255, 255}}
	tbl.Hand.StreetCommit[0] = 1
	tbl.Hand.TotalCommit[0] = 1

	tbl.Seats[1] = &types.Seat{Player: p1.String(), Stack: 98, Bond: 0, Hole: []uint32{255, 255}}
	tbl.Hand.StreetCommit[1] = 2
	tbl.Hand.TotalCommit[1] = 2

	require.NoError(t, k.SetTable(ctx, tbl))

	// P1 checks (BetTo=2, P1 already committed 2).
	_, err := ms.Act(ctx, &types.MsgAct{
		Player:  p1.String(),
		TableId: 1,
		Action:  "check",
		Amount:  0,
	})
	require.NoError(t, err)

	tbl2, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotNil(t, tbl2)
	// With Dealer: nil and no one left to act, street should be complete.
	// Both are no longer able to act (P0 all-in, P1 checked). Hand remains with no dealer.
	require.NotNil(t, tbl2.Hand, "hand remains active with no dealer to advance")
	require.True(t, tbl2.Hand.AllIn[0], "P0 should still be all-in")
}

func TestStartHandRejectsOnePlayer(t *testing.T) {
	oldDenom := sdk.DefaultBondDenom
	sdk.DefaultBondDenom = "uocp"
	defer func() { sdk.DefaultBondDenom = oldDenom }()

	sdkCtx, _, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	p0 := addr(0xC0).String()
	pkBytes := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()

	// Create table and sit only one player.
	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:    p0,
		SmallBlind: 1, BigBlind: 2,
		MinBuyIn: 100, MaxBuyIn: 1000,
		MaxPlayers: 9, Label: "one-player",
	})
	require.NoError(t, err)

	_, err = ms.Sit(ctx, &types.MsgSit{
		Player: p0, TableId: 1, BuyIn: 100, PkPlayer: pkBytes,
	})
	require.NoError(t, err)

	// StartHand should fail with only 1 player.
	_, err = ms.StartHand(ctx, &types.MsgStartHand{Caller: p0, TableId: 1})
	require.Error(t, err)
	require.ErrorContains(t, err, "need at least 2 players with chips")
}

func TestSitAutoAssignDifferentPlayers(t *testing.T) {
	oldDenom := sdk.DefaultBondDenom
	sdk.DefaultBondDenom = "uocp"
	defer func() { sdk.DefaultBondDenom = oldDenom }()

	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	p0 := addr(0xD0).String()
	p1 := addr(0xD1).String()
	pkBytes := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:    p0,
		SmallBlind: 1, BigBlind: 2,
		MinBuyIn: 100, MaxBuyIn: 1000,
		MaxPlayers: 9, Label: "auto-assign",
	})
	require.NoError(t, err)

	resp0, err := ms.Sit(ctx, &types.MsgSit{
		Player: p0, TableId: 1, BuyIn: 100, PkPlayer: pkBytes,
	})
	require.NoError(t, err)
	require.Equal(t, uint32(0), resp0.Seat, "first player gets seat 0")

	// P1 sits — should auto-assign a different seat.
	resp1, err := ms.Sit(ctx, &types.MsgSit{
		Player: p1, TableId: 1, BuyIn: 100, PkPlayer: pkBytes,
	})
	require.NoError(t, err)
	require.Equal(t, uint32(1), resp1.Seat, "second player gets seat 1")

	tbl, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, p0, tbl.Seats[0].Player)
	require.Equal(t, p1, tbl.Seats[1].Player)
}

// ---------------------------------------------------------------------------
// Password, double-seat, auto-assign tests
// ---------------------------------------------------------------------------

func TestSitRejectsSamePlayerTwice(t *testing.T) {
	oldDenom := sdk.DefaultBondDenom
	sdk.DefaultBondDenom = "uocp"
	defer func() { sdk.DefaultBondDenom = oldDenom }()

	sdkCtx, _, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	p0 := addr(0xE0).String()
	pkBytes := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:    p0,
		SmallBlind: 1, BigBlind: 2,
		MinBuyIn: 100, MaxBuyIn: 1000,
		MaxPlayers: 9, Label: "double-seat",
	})
	require.NoError(t, err)

	_, err = ms.Sit(ctx, &types.MsgSit{
		Player: p0, TableId: 1, BuyIn: 100, PkPlayer: pkBytes,
	})
	require.NoError(t, err)

	// Same player tries to sit again.
	_, err = ms.Sit(ctx, &types.MsgSit{
		Player: p0, TableId: 1, BuyIn: 100, PkPlayer: pkBytes,
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "already seated")
}

func TestSitPasswordRequired(t *testing.T) {
	oldDenom := sdk.DefaultBondDenom
	sdk.DefaultBondDenom = "uocp"
	defer func() { sdk.DefaultBondDenom = oldDenom }()

	sdkCtx, _, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	creator := addr(0xE1).String()
	p0 := addr(0xE2).String()
	pkBytes := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()

	// Create password-protected table.
	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:    creator,
		SmallBlind: 1, BigBlind: 2,
		MinBuyIn: 100, MaxBuyIn: 1000,
		MaxPlayers: 9, Label: "pw-table",
		Password: "secret",
	})
	require.NoError(t, err)

	// Sit without password → rejected.
	_, err = ms.Sit(ctx, &types.MsgSit{
		Player: p0, TableId: 1, BuyIn: 100, PkPlayer: pkBytes,
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "password required")

	// Sit with wrong password → rejected.
	_, err = ms.Sit(ctx, &types.MsgSit{
		Player: p0, TableId: 1, BuyIn: 100, PkPlayer: pkBytes,
		Password: "wrong",
	})
	require.Error(t, err)
	require.ErrorContains(t, err, "wrong password")

	// Sit with correct password → success.
	resp, err := ms.Sit(ctx, &types.MsgSit{
		Player: p0, TableId: 1, BuyIn: 100, PkPlayer: pkBytes,
		Password: "secret",
	})
	require.NoError(t, err)
	require.Equal(t, uint32(0), resp.Seat)
}

func TestSitAutoAssignSeat(t *testing.T) {
	oldDenom := sdk.DefaultBondDenom
	sdk.DefaultBondDenom = "uocp"
	defer func() { sdk.DefaultBondDenom = oldDenom }()

	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	pkBytes := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()
	p0 := addr(0xE3).String()
	p1 := addr(0xE4).String()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:    p0,
		SmallBlind: 1, BigBlind: 2,
		MinBuyIn: 100, MaxBuyIn: 1000,
		MaxPlayers: 9, Label: "auto-seat",
	})
	require.NoError(t, err)

	resp0, err := ms.Sit(ctx, &types.MsgSit{Player: p0, TableId: 1, BuyIn: 100, PkPlayer: pkBytes})
	require.NoError(t, err)
	require.Equal(t, uint32(0), resp0.Seat, "first player on fresh table gets seat 0")

	resp1, err := ms.Sit(ctx, &types.MsgSit{Player: p1, TableId: 1, BuyIn: 100, PkPlayer: pkBytes})
	require.NoError(t, err)
	require.Equal(t, uint32(1), resp1.Seat, "second player gets seat 1")

	tbl, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, p0, tbl.Seats[0].Player)
	require.Equal(t, p1, tbl.Seats[1].Player)
}

func TestAutoAssignSeatFullTable(t *testing.T) {
	oldDenom := sdk.DefaultBondDenom
	sdk.DefaultBondDenom = "uocp"
	defer func() { sdk.DefaultBondDenom = oldDenom }()

	sdkCtx, _, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	pkBytes := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()
	creator := addr(0xF0).String()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:    creator,
		SmallBlind: 1, BigBlind: 2,
		MinBuyIn: 100, MaxBuyIn: 1000,
		MaxPlayers: 9, Label: "full-table",
	})
	require.NoError(t, err)

	// Fill all 9 seats.
	for i := 0; i < 9; i++ {
		p := addr(byte(0xF0 + i + 1)).String()
		_, err := ms.Sit(ctx, &types.MsgSit{Player: p, TableId: 1, BuyIn: 100, PkPlayer: pkBytes})
		require.NoError(t, err, "player %d should sit", i)
	}

	// 10th player → table full.
	p10 := addr(0xFA).String()
	_, err = ms.Sit(ctx, &types.MsgSit{Player: p10, TableId: 1, BuyIn: 100, PkPlayer: pkBytes})
	require.Error(t, err)
	require.ErrorContains(t, err, "table full")
}

func TestAutoAssignSeatEmptyTable(t *testing.T) {
	oldDenom := sdk.DefaultBondDenom
	sdk.DefaultBondDenom = "uocp"
	defer func() { sdk.DefaultBondDenom = oldDenom }()

	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	pkBytes := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()
	p0 := addr(0xE5).String()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:    p0,
		SmallBlind: 1, BigBlind: 2,
		MinBuyIn: 100, MaxBuyIn: 1000,
		MaxPlayers: 9, Label: "empty",
	})
	require.NoError(t, err)

	// Verify ButtonSeat is -1 (fresh table).
	tbl, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.Equal(t, int32(-1), tbl.ButtonSeat)

	// First player gets seat 0.
	resp, err := ms.Sit(ctx, &types.MsgSit{Player: p0, TableId: 1, BuyIn: 100, PkPlayer: pkBytes})
	require.NoError(t, err)
	require.Equal(t, uint32(0), resp.Seat)
}

func TestAutoAssignSeatPlacement(t *testing.T) {
	// Test that new player is placed after the BB position.
	// Setup: 3 players at seats 0, 3, 7. Button at seat 0.
	// BB should be at seat 7 (SB at seat 3 in 3-player, BB = next after SB).
	// New player should get first empty seat after seat 7 → seat 1.

	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	pkBytes := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()
	p0 := addr(0xE6).String()
	p3 := addr(0xE7).String()
	p7 := addr(0xE8).String()
	pNew := addr(0xE9).String()

	// Create table and manually set up seats.
	tbl := &types.Table{
		Id:      1,
		Creator: p0,
		Label:   "placement-test",
		Params: types.TableParams{
			MaxPlayers: 9,
			SmallBlind: 1, BigBlind: 2,
			MinBuyIn: 100, MaxBuyIn: 1000,
		},
		Seats:      make([]*types.Seat, 9),
		NextHandId: 2,
		ButtonSeat: 0,
		Hand:       nil,
	}
	tbl.Seats[0] = &types.Seat{Player: p0, Stack: 100, Hole: []uint32{255, 255}}
	tbl.Seats[3] = &types.Seat{Player: p3, Stack: 100, Hole: []uint32{255, 255}}
	tbl.Seats[7] = &types.Seat{Player: p7, Stack: 100, Hole: []uint32{255, 255}}
	require.NoError(t, k.SetNextTableID(ctx, 2))
	require.NoError(t, k.SetTable(ctx, tbl))

	// Sit new player — should be placed after BB (seat 7) → seat 1 (first empty after 7).
	resp, err := ms.Sit(ctx, &types.MsgSit{Player: pNew, TableId: 1, BuyIn: 100, PkPlayer: pkBytes})
	require.NoError(t, err)
	// BB is at seat 7 (SB=3, BB=7 for 3-player with button=0).
	// Clockwise from 7: seats 8, 0, 1, 2, ... — seat 8 is empty → gets seat 8.
	// Wait: let me re-check. With button=0, active seats with stack = [0, 3, 7].
	// SB = nextOccupiedSeat(0) = 3, BB = nextOccupiedSeat(3) = 7. BB = 7.
	// Walk from 7+1=8: seat 8 is nil → empty → assign seat 8.
	require.Equal(t, uint32(8), resp.Seat, "new player placed after BB at seat 7 → first empty is seat 8")
}

func TestCreateTableWithPassword(t *testing.T) {
	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	creator := addr(0xEA).String()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:    creator,
		SmallBlind: 1, BigBlind: 2,
		MinBuyIn: 100, MaxBuyIn: 1000,
		MaxPlayers: 9, Label: "pw",
		Password: "testpass",
	})
	require.NoError(t, err)

	tbl, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.NotEmpty(t, tbl.Params.PasswordHash, "password hash should be set")
	require.Len(t, tbl.Params.PasswordHash, 32, "SHA-256 produces 32 bytes")

	// Verify hash matches SHA-256 of "testpass".
	expected := sha256.Sum256([]byte("testpass"))
	require.Equal(t, expected[:], tbl.Params.PasswordHash)
}

func TestCreateTableNoPassword(t *testing.T) {
	sdkCtx, k, ms, _ := newKeeper(t, time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	creator := addr(0xEB).String()

	_, err := ms.CreateTable(ctx, &types.MsgCreateTable{
		Creator:    creator,
		SmallBlind: 1, BigBlind: 2,
		MinBuyIn: 100, MaxBuyIn: 1000,
		MaxPlayers: 9, Label: "no-pw",
	})
	require.NoError(t, err)

	tbl, err := k.GetTable(ctx, 1)
	require.NoError(t, err)
	require.Empty(t, tbl.Params.PasswordHash, "password hash should be empty")
}
