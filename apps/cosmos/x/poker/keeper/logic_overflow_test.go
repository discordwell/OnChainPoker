package keeper

import (
	"testing"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/stretchr/testify/require"

	"onchainpoker/apps/cosmos/x/poker/types"
)

func newOverflowTestTable() *types.Table {
	t := &types.Table{
		Id: 1,
		Params: types.TableParams{
			BigBlind: 1,
		},
		Seats: make([]*types.Seat, 9),
		Hand: &types.Hand{
			HandId:       1,
			Phase:        types.HandPhase_HAND_PHASE_BETTING,
			Street:       types.Street_STREET_PREFLOP,
			InHand:       make([]bool, 9),
			Folded:       make([]bool, 9),
			AllIn:        make([]bool, 9),
			StreetCommit: make([]uint64, 9),
			TotalCommit:  make([]uint64, 9),
			LastIntervalActed: []int32{
				-1, -1, -1, -1, -1, -1, -1, -1, -1,
			},
			Board: []uint32{0, 1, 2, 3, 4},
		},
	}
	return t
}

func TestApplyBetTo_MaxCommitOverflowDoesNotMutate(t *testing.T) {
	tbl := newOverflowTestTable()
	tbl.Seats[0] = &types.Seat{Player: "p0", Stack: 2, Hole: []uint32{255, 255}}
	tbl.Hand.InHand[0] = true
	tbl.Hand.StreetCommit[0] = ^uint64(0) - 1
	tbl.Hand.TotalCommit[0] = 9
	tbl.Hand.BetTo = 0

	err := applyBetTo(tbl, 0, ^uint64(0))
	require.ErrorContains(t, err, "max commit overflows uint64")
	require.Equal(t, uint64(2), tbl.Seats[0].Stack)
	require.Equal(t, ^uint64(0)-1, tbl.Hand.StreetCommit[0])
	require.Equal(t, uint64(9), tbl.Hand.TotalCommit[0])
	require.Equal(t, uint64(0), tbl.Hand.BetTo)
}

func TestReturnUncalledStreetExcess_OverflowDoesNotMutate(t *testing.T) {
	tbl := newOverflowTestTable()
	tbl.Seats[0] = &types.Seat{Player: "p0", Stack: ^uint64(0), Hole: []uint32{255, 255}}
	tbl.Seats[1] = &types.Seat{Player: "p1", Stack: 10, Hole: []uint32{255, 255}}
	tbl.Hand.StreetCommit[0] = 50
	tbl.Hand.StreetCommit[1] = 49
	tbl.Hand.TotalCommit[0] = 50
	tbl.Hand.TotalCommit[1] = 49

	err := returnUncalledStreetExcess(tbl)
	require.ErrorContains(t, err, "seat stack overflows uint64")
	require.Equal(t, ^uint64(0), tbl.Seats[0].Stack)
	require.Equal(t, uint64(50), tbl.Hand.StreetCommit[0])
	require.Equal(t, uint64(50), tbl.Hand.TotalCommit[0])
}

func TestCompleteByFolds_WinnerAwardOverflow(t *testing.T) {
	tbl := newOverflowTestTable()
	tbl.Seats[0] = &types.Seat{Player: "p0", Stack: ^uint64(0), Hole: []uint32{255, 255}}
	tbl.Seats[1] = &types.Seat{Player: "p1", Stack: 10, Hole: []uint32{255, 255}}
	tbl.Hand.InHand[0] = true
	tbl.Hand.InHand[1] = true
	tbl.Hand.Folded[1] = true
	tbl.Hand.TotalCommit[0] = 1
	tbl.Hand.TotalCommit[1] = 1

	ev := []sdk.Event{}
	err := completeByFolds(tbl, &ev)
	require.ErrorContains(t, err, "winner stack overflows uint64")
	require.NotNil(t, tbl.Hand)
	require.Equal(t, ^uint64(0), tbl.Seats[0].Stack)
	require.Empty(t, ev)
}

func TestComputeSidePots_PotAmountOverflow(t *testing.T) {
	totalCommit := make([]uint64, 9)
	eligible := make([]bool, 9)
	totalCommit[0] = ^uint64(0)
	totalCommit[1] = ^uint64(0)
	eligible[0] = true
	eligible[1] = true

	pots, err := computeSidePots(totalCommit, eligible)
	require.ErrorContains(t, err, "pot amount overflows uint64")
	require.Nil(t, pots)
}

func TestSettleKnownShowdown_SeatAwardOverflow(t *testing.T) {
	tbl := newOverflowTestTable()
	tbl.Seats[0] = &types.Seat{Player: "p0", Stack: ^uint64(0), Hole: []uint32{255, 255}}
	tbl.Seats[1] = &types.Seat{Player: "p1", Stack: 10, Hole: []uint32{255, 255}}
	tbl.Hand.InHand[0] = true
	tbl.Hand.InHand[1] = true
	tbl.Hand.Folded[1] = true
	tbl.Hand.TotalCommit[0] = 1
	tbl.Hand.TotalCommit[1] = 1

	events, err := settleKnownShowdown(tbl)
	require.ErrorContains(t, err, "seat stack award overflows uint64")
	require.Nil(t, events)
	require.NotNil(t, tbl.Hand)
	require.Equal(t, ^uint64(0), tbl.Seats[0].Stack)
}

func TestAbortHandRefundAllCommits_RefundOverflow(t *testing.T) {
	tbl := newOverflowTestTable()
	tbl.Seats[0] = &types.Seat{Player: "p0", Stack: ^uint64(0), Hole: []uint32{255, 255}}
	tbl.Hand.TotalCommit[0] = 1

	events, err := abortHandRefundAllCommits(tbl, "abort")
	require.ErrorContains(t, err, "seat stack refund overflows uint64")
	require.Nil(t, events)
	require.NotNil(t, tbl.Hand)
	require.Equal(t, ^uint64(0), tbl.Seats[0].Stack)
}
