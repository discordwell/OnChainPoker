package keeper

import (
	"bytes"
	"testing"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	"github.com/stretchr/testify/require"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
	pokertypes "onchainpoker/apps/cosmos/x/poker/types"
)

func TestInitHand_AcceptsTableCreatorGamemaster(t *testing.T) {
	caller := sdk.AccAddress(bytes.Repeat([]byte{0xc1}, 20)).String()
	// Bonded validator is unrelated to the caller.
	valoper := sdk.ValAddress(bytes.Repeat([]byte{0xd1}, 20)).String()
	bonded := []stakingtypes.Validator{
		makeBondedValidatorForDealerTest(t, valoper, 1, 0xbb),
	}

	ctx, k, ms, pokerKeeper := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 1, bonded)

	pkEpoch := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(9))
	require.NoError(t, k.SetEpoch(ctx, &dealertypes.DealerEpoch{
		EpochId:   1,
		Threshold: 2,
		PkEpoch:   append([]byte(nil), pkEpoch.Bytes()...),
		Members: []dealertypes.DealerMember{
			{Validator: valoper, Index: 1, ConsPubkey: bytes.Repeat([]byte{0xbb}, 32), Power: 1},
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
			DealerTimeoutSecs: 30,
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
	}))

	_, err := ms.InitHand(ctx, &dealertypes.MsgInitHand{
		Caller:   caller,
		TableId:  1,
		HandId:   1,
		EpochId:  1,
		DeckSize: 2,
	})
	require.NoError(t, err, "table creator (gamemaster) should bypass validator auth")

	dh, err := k.GetHand(ctx, 1, 1)
	require.NoError(t, err)
	require.NotNil(t, dh, "dealer hand should have been initialized")
	require.Equal(t, uint64(1), dh.EpochId)
}

func TestInitHand_AcceptsActiveBondedValidator(t *testing.T) {
	// Caller and validator share the same key bytes so requireActiveBondedCaller passes.
	keyBytes := bytes.Repeat([]byte{0xa5}, 20)
	callerAcc := sdk.AccAddress(keyBytes).String()
	valoper := sdk.ValAddress(keyBytes).String()
	bonded := []stakingtypes.Validator{
		makeBondedValidatorForDealerTest(t, valoper, 1, 0xa5),
	}
	// Creator is unrelated — auth must succeed via validator path.
	creator := sdk.AccAddress(bytes.Repeat([]byte{0x12}, 20)).String()

	ctx, k, ms, pokerKeeper := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 1, bonded)

	pkEpoch := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(9))
	require.NoError(t, k.SetEpoch(ctx, &dealertypes.DealerEpoch{
		EpochId:   1,
		Threshold: 2,
		PkEpoch:   append([]byte(nil), pkEpoch.Bytes()...),
		Members: []dealertypes.DealerMember{
			{Validator: valoper, Index: 1, ConsPubkey: bytes.Repeat([]byte{0xa5}, 32), Power: 1},
		},
		StartHeight: 1,
	}))

	holePos := make([]uint32, 18)
	for i := range holePos {
		holePos[i] = 255
	}
	require.NoError(t, pokerKeeper.SetTable(ctx, &pokertypes.Table{
		Id:      1,
		Creator: creator,
		Params: pokertypes.TableParams{
			MaxPlayers:        9,
			SmallBlind:        1,
			BigBlind:          2,
			MinBuyIn:          1,
			MaxBuyIn:          1000,
			DealerTimeoutSecs: 30,
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
	}))

	_, err := ms.InitHand(ctx, &dealertypes.MsgInitHand{
		Caller:   callerAcc,
		TableId:  1,
		HandId:   1,
		EpochId:  1,
		DeckSize: 2,
	})
	require.NoError(t, err, "active bonded validator should authorize InitHand")

	dh, err := k.GetHand(ctx, 1, 1)
	require.NoError(t, err)
	require.NotNil(t, dh)
}

func TestInitHand_RejectsNonCreatorNonValidator(t *testing.T) {
	// Bonded validator is unrelated to caller.
	valoper := sdk.ValAddress(bytes.Repeat([]byte{0x99}, 20)).String()
	bonded := []stakingtypes.Validator{
		makeBondedValidatorForDealerTest(t, valoper, 1, 0x99),
	}
	creator := sdk.AccAddress(bytes.Repeat([]byte{0x77}, 20)).String()
	// Attacker: different bytes from both creator and validator.
	attacker := sdk.AccAddress(bytes.Repeat([]byte{0x66}, 20)).String()

	ctx, k, ms, pokerKeeper := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 1, bonded)

	pkEpoch := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(9))
	require.NoError(t, k.SetEpoch(ctx, &dealertypes.DealerEpoch{
		EpochId:   1,
		Threshold: 2,
		PkEpoch:   append([]byte(nil), pkEpoch.Bytes()...),
		Members: []dealertypes.DealerMember{
			{Validator: valoper, Index: 1, ConsPubkey: bytes.Repeat([]byte{0x99}, 32), Power: 1},
		},
		StartHeight: 1,
	}))

	holePos := make([]uint32, 18)
	for i := range holePos {
		holePos[i] = 255
	}
	require.NoError(t, pokerKeeper.SetTable(ctx, &pokertypes.Table{
		Id:      1,
		Creator: creator,
		Params: pokertypes.TableParams{
			MaxPlayers:        9,
			SmallBlind:        1,
			BigBlind:          2,
			MinBuyIn:          1,
			MaxBuyIn:          1000,
			DealerTimeoutSecs: 30,
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
	}))

	_, err := ms.InitHand(ctx, &dealertypes.MsgInitHand{
		Caller:   attacker,
		TableId:  1,
		HandId:   1,
		EpochId:  1,
		DeckSize: 2,
	})
	require.Error(t, err)
	require.ErrorIs(t, err, dealertypes.ErrUnauthorized)

	dh, err := k.GetHand(ctx, 1, 1)
	require.NoError(t, err)
	require.Nil(t, dh, "dealer hand should not be created on auth failure")
}
