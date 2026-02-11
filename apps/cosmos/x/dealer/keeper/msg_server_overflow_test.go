package keeper

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
	sdked25519 "github.com/cosmos/cosmos-sdk/crypto/keys/ed25519"
	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/testutil"
	sdk "github.com/cosmos/cosmos-sdk/types"
	slashingtypes "github.com/cosmos/cosmos-sdk/x/slashing/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	"github.com/gogo/protobuf/proto"
	"github.com/stretchr/testify/require"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
	"onchainpoker/apps/cosmos/internal/ocpshuffle"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
	pokertypes "onchainpoker/apps/cosmos/x/poker/types"
)

type fakeDealerStakingKeeper struct {
	bonded []stakingtypes.Validator
}

func (f fakeDealerStakingKeeper) Validator(_ context.Context, _ sdk.ValAddress) (stakingtypes.ValidatorI, error) {
	return nil, nil
}

func (f fakeDealerStakingKeeper) GetBondedValidatorsByPower(_ context.Context) ([]stakingtypes.Validator, error) {
	return f.bonded, nil
}

type fakeDealerSlashingKeeper struct{}

func (fakeDealerSlashingKeeper) SlashWithInfractionReason(
	_ context.Context,
	_ sdk.ConsAddress,
	_ sdkmath.LegacyDec,
	_ int64,
	_ int64,
	_ stakingtypes.Infraction,
) error {
	return nil
}

func (fakeDealerSlashingKeeper) Jail(_ context.Context, _ sdk.ConsAddress) error { return nil }

func (fakeDealerSlashingKeeper) GetValidatorSigningInfo(_ context.Context, _ sdk.ConsAddress) (slashingtypes.ValidatorSigningInfo, error) {
	return slashingtypes.ValidatorSigningInfo{}, nil
}

func (fakeDealerSlashingKeeper) JailUntil(_ context.Context, _ sdk.ConsAddress, _ time.Time) error {
	return nil
}

type fakeDealerPokerKeeper struct {
	tables   map[uint64]*pokertypes.Table
	setCalls int
}

func clonePokerTable(t *pokertypes.Table) *pokertypes.Table {
	if t == nil {
		return nil
	}
	return proto.Clone(t).(*pokertypes.Table)
}

func (f *fakeDealerPokerKeeper) GetTable(_ context.Context, tableID uint64) (*pokertypes.Table, error) {
	return clonePokerTable(f.tables[tableID]), nil
}

func (f *fakeDealerPokerKeeper) SetTable(_ context.Context, t *pokertypes.Table) error {
	f.setCalls++
	if t == nil {
		return nil
	}
	f.tables[t.Id] = clonePokerTable(t)
	return nil
}

func (f *fakeDealerPokerKeeper) AbortHandRefundAllCommits(_ context.Context, _, _ uint64, _ string) ([]sdk.Event, error) {
	return nil, nil
}

func (f *fakeDealerPokerKeeper) ApplyDealerReveal(_ context.Context, _, _ uint64, _ uint32, _ uint32, _ int64) ([]sdk.Event, error) {
	return nil, nil
}

func (f *fakeDealerPokerKeeper) AdvanceAfterHoleSharesReady(_ context.Context, _, _ uint64, _ int64) error {
	return nil
}

func newDealerMsgServerForOverflowTests(t *testing.T, blockTime time.Time, blockHeight int64, bonded []stakingtypes.Validator) (context.Context, Keeper, dealertypes.MsgServer, *fakeDealerPokerKeeper) {
	t.Helper()

	key := storetypes.NewKVStoreKey(dealertypes.StoreKey)
	storeService := runtime.NewKVStoreService(key)
	testCtx := testutil.DefaultContextWithDB(t, key, storetypes.NewTransientStoreKey("transient_test"))
	sdkCtx := testCtx.Ctx.WithEventManager(sdk.NewEventManager()).WithBlockTime(blockTime).WithBlockHeight(blockHeight)
	ctx := sdk.WrapSDKContext(sdkCtx)

	ir := codectypes.NewInterfaceRegistry()
	cdc := codec.NewProtoCodec(ir)

	stakingKeeper := fakeDealerStakingKeeper{bonded: bonded}
	pokerKeeper := &fakeDealerPokerKeeper{tables: map[uint64]*pokertypes.Table{}}
	k := NewKeeper(
		cdc,
		storeService,
		sdk.AccAddress(bytes.Repeat([]byte{0x7a}, 20)).String(),
		stakingKeeper,
		stakingKeeper,
		fakeDealerSlashingKeeper{},
		pokerKeeper,
	)

	return ctx, k, NewMsgServerImpl(k), pokerKeeper
}

func makeBondedValidatorForDealerTest(t *testing.T, valoper string, power int64, pkByte byte) stakingtypes.Validator {
	t.Helper()
	pk := &sdked25519.PubKey{Key: bytes.Repeat([]byte{pkByte}, 32)}
	v, err := stakingtypes.NewValidator(valoper, pk, stakingtypes.NewDescription("", "", "", "", ""))
	require.NoError(t, err)
	v.Status = stakingtypes.Bonded
	v.Tokens = sdkmath.NewInt(power * 1_000_000)
	return v
}

func TestBeginEpoch_HugeBlockHeightOverflowDoesNotMutateState(t *testing.T) {
	caller := sdk.AccAddress(bytes.Repeat([]byte{0x11}, 20)).String()
	valoper := sdk.ValAddress(bytes.Repeat([]byte{0x22}, 20)).String()
	bonded := []stakingtypes.Validator{
		makeBondedValidatorForDealerTest(t, valoper, 1, 0xaa),
	}

	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), math.MaxInt64, bonded)

	_, err := ms.BeginEpoch(ctx, &dealertypes.MsgBeginEpoch{
		Caller:          caller,
		EpochId:         1,
		CommitteeSize:   1,
		Threshold:       1,
		CommitBlocks:    1,
		ComplaintBlocks: 1,
		RevealBlocks:    1,
		FinalizeBlocks:  1,
	})
	require.ErrorContains(t, err, "dkg commit deadline overflows int64")

	next, getErr := k.GetNextEpochID(ctx)
	require.NoError(t, getErr)
	require.Equal(t, uint64(1), next)

	dkg, getErr := k.GetDKG(ctx)
	require.NoError(t, getErr)
	require.Nil(t, dkg)
}

func TestInitHand_HugeTimeoutOverflowDoesNotMutateState(t *testing.T) {
	caller := sdk.AccAddress(bytes.Repeat([]byte{0x31}, 20)).String()
	valoper := sdk.ValAddress(bytes.Repeat([]byte{0x32}, 20)).String()
	bonded := []stakingtypes.Validator{
		makeBondedValidatorForDealerTest(t, valoper, 1, 0xbb),
	}

	ctx, k, ms, pokerKeeper := newDealerMsgServerForOverflowTests(t, time.Unix(math.MaxInt64, 0).UTC(), 1, bonded)

	pkEpoch := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(9))
	require.NoError(t, k.SetEpoch(ctx, &dealertypes.DealerEpoch{
		EpochId:   1,
		Threshold: 1,
		PkEpoch:   append([]byte(nil), pkEpoch.Bytes()...),
		Members: []dealertypes.DealerMember{
			{
				Validator:  valoper,
				Index:      1,
				ConsPubkey: bytes.Repeat([]byte{0xbb}, 32),
				Power:      1,
			},
		},
		StartHeight: 1,
	}))

	holePos := make([]uint32, 18)
	for i := range holePos {
		holePos[i] = 255
	}
	tbl := &pokertypes.Table{
		Id:      1,
		Creator: caller,
		Params: pokertypes.TableParams{
			MaxPlayers:        9,
			SmallBlind:        1,
			BigBlind:          2,
			MinBuyIn:          1,
			MaxBuyIn:          1000,
			DealerTimeoutSecs: 1,
		},
		Seats:      make([]*pokertypes.Seat, 9),
		NextHandId: 2,
		ButtonSeat: -1,
		Hand: &pokertypes.Hand{
			HandId: 1,
			Phase:  pokertypes.HandPhase_HAND_PHASE_SHUFFLE,
			Street: pokertypes.Street_STREET_PREFLOP,
			Dealer: &pokertypes.DealerMeta{
				HolePos:        holePos,
				RevealPos:      255,
				RevealDeadline: 0,
			},
		},
	}
	require.NoError(t, pokerKeeper.SetTable(ctx, tbl))
	before := pokerKeeper.setCalls

	_, err := ms.InitHand(ctx, &dealertypes.MsgInitHand{
		Caller:   caller,
		TableId:  1,
		HandId:   1,
		EpochId:  1,
		DeckSize: 2,
	})
	require.ErrorContains(t, err, "dealer shuffle deadline overflows int64")

	require.Equal(t, before, pokerKeeper.setCalls, "SetTable should not be called on overflow")
	gotTable, getErr := pokerKeeper.GetTable(ctx, 1)
	require.NoError(t, getErr)
	require.NotNil(t, gotTable)
	require.Equal(t, uint32(0), gotTable.Hand.Dealer.DeckSize)
	require.False(t, gotTable.Hand.Dealer.DeckFinalized)

	dh, getErr := k.GetHand(ctx, 1, 1)
	require.NoError(t, getErr)
	require.Nil(t, dh)
}

func TestSubmitShuffle_HugeTimeoutOverflowDoesNotMutateState(t *testing.T) {
	caller := sdk.AccAddress(bytes.Repeat([]byte{0x41}, 20)).String()
	valoper := sdk.ValAddress(bytes.Repeat([]byte{0x42}, 20)).String()
	bonded := []stakingtypes.Validator{
		makeBondedValidatorForDealerTest(t, valoper, 1, 0xcc),
	}

	ctx, k, ms, pokerKeeper := newDealerMsgServerForOverflowTests(t, time.Unix(math.MaxInt64, 0).UTC(), 1, bonded)

	pkEpoch := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(3))
	require.NoError(t, k.SetEpoch(ctx, &dealertypes.DealerEpoch{
		EpochId:   1,
		Threshold: 1,
		PkEpoch:   append([]byte(nil), pkEpoch.Bytes()...),
		Members: []dealertypes.DealerMember{
			{
				Validator:  valoper,
				Index:      1,
				ConsPubkey: bytes.Repeat([]byte{0xcc}, 32),
				Power:      1,
			},
		},
		StartHeight: 1,
	}))

	holePos := make([]uint32, 18)
	for i := range holePos {
		holePos[i] = 255
	}
	require.NoError(t, pokerKeeper.SetTable(ctx, &pokertypes.Table{
		Id:      1,
		Creator: caller,
		Params: pokertypes.TableParams{
			MaxPlayers:        9,
			SmallBlind:        1,
			BigBlind:          2,
			MinBuyIn:          1,
			MaxBuyIn:          1000,
			DealerTimeoutSecs: 1,
		},
		Seats:      make([]*pokertypes.Seat, 9),
		NextHandId: 2,
		ButtonSeat: -1,
		Hand: &pokertypes.Hand{
			HandId: 1,
			Phase:  pokertypes.HandPhase_HAND_PHASE_SHUFFLE,
			Street: pokertypes.Street_STREET_PREFLOP,
			Dealer: &pokertypes.DealerMeta{
				HolePos:   holePos,
				RevealPos: 255,
			},
		},
	}))

	pkHand := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(17))
	deckIn := make([]ocpcrypto.ElGamalCiphertext, 0, 2)
	deckProto := make([]dealertypes.DealerCiphertext, 0, 2)
	for i := 0; i < 2; i++ {
		ct, err := ocpcrypto.ElGamalEncrypt(pkHand, cardPoint(i), ocpcrypto.ScalarFromUint64(uint64(i+1)))
		require.NoError(t, err)
		deckIn = append(deckIn, ct)
		deckProto = append(deckProto, dealertypes.DealerCiphertext{
			C1: append([]byte(nil), ct.C1.Bytes()...),
			C2: append([]byte(nil), ct.C2.Bytes()...),
		})
	}

	proof, err := ocpshuffle.ShuffleProveV1(pkHand, deckIn, ocpshuffle.ShuffleProveOpts{
		Seed:   bytes.Repeat([]byte{0x5a}, 32),
		Rounds: 2,
	})
	require.NoError(t, err)

	require.NoError(t, k.SetHand(ctx, 1, 1, &dealertypes.DealerHand{
		EpochId:         1,
		PkHand:          append([]byte(nil), pkHand.Bytes()...),
		DeckSize:        2,
		Deck:            deckProto,
		ShuffleStep:     0,
		Finalized:       false,
		ShuffleDeadline: 0,
	}))

	_, err = ms.SubmitShuffle(ctx, &dealertypes.MsgSubmitShuffle{
		Shuffler:     valoper,
		TableId:      1,
		HandId:       1,
		Round:        1,
		ProofShuffle: proof.ProofBytes,
	})
	require.ErrorContains(t, err, "dealer shuffle deadline overflows int64")

	dh, getErr := k.GetHand(ctx, 1, 1)
	require.NoError(t, getErr)
	require.NotNil(t, dh)
	require.Equal(t, uint32(0), dh.ShuffleStep)
	require.Equal(t, int64(0), dh.ShuffleDeadline)
	require.Equal(t, deckProto, dh.Deck)
}
