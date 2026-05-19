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

func TestSettleKnownShowdown_RefundsPotWhenNoEligibleReveals(t *testing.T) {
	tbl := newOverflowTestTable()
	// 3 seats in-hand, none folded, none revealed (Hole sentinels 255/255).
	tbl.Seats[0] = &types.Seat{Player: "p0", Stack: 100, Hole: []uint32{255, 255}}
	tbl.Seats[1] = &types.Seat{Player: "p1", Stack: 200, Hole: []uint32{255, 255}}
	tbl.Seats[2] = &types.Seat{Player: "p2", Stack: 300, Hole: []uint32{255, 255}}
	tbl.Hand.InHand[0] = true
	tbl.Hand.InHand[1] = true
	tbl.Hand.InHand[2] = true
	tbl.Hand.TotalCommit[0] = 10
	tbl.Hand.TotalCommit[1] = 10
	tbl.Hand.TotalCommit[2] = 10

	events, err := settleKnownShowdown(tbl)
	require.NoError(t, err)

	// Pot = 30; 3 eligibles, share=10 each, no remainder.
	require.Equal(t, uint64(110), tbl.Seats[0].Stack)
	require.Equal(t, uint64(210), tbl.Seats[1].Stack)
	require.Equal(t, uint64(310), tbl.Seats[2].Stack)
	// Hand cleared on completion.
	require.Nil(t, tbl.Hand)

	// Expect a PotRefunded event with tableId/handId/potIndex/amount and refund details.
	var refund *sdk.Event
	for i := range events {
		if events[i].Type == types.EventTypePotRefunded {
			refund = &events[i]
			break
		}
	}
	require.NotNil(t, refund, "expected PotRefunded event")
	attrs := map[string]string{}
	for _, a := range refund.Attributes {
		attrs[a.Key] = a.Value
	}
	require.Equal(t, "1", attrs["tableId"])
	require.Equal(t, "1", attrs["handId"])
	require.Equal(t, "0", attrs["potIndex"])
	require.Equal(t, "30", attrs["amount"])
	require.Equal(t, "0,1,2", attrs["eligibleSeats"])
	require.Equal(t, "0,1,2", attrs["refundedSeats"])
	require.Equal(t, "10,10,10", attrs["refundedAmounts"])
	require.Equal(t, "no-eligible-reveals", attrs["reason"])
}

func TestSettleKnownShowdown_RefundRemainderGoesToFirstEligible(t *testing.T) {
	tbl := newOverflowTestTable()
	// 3 in-hand-not-folded seats (no reveals) + 1 folded contributor with a small commit.
	// computeSidePots merges consecutive same-eligibility tiers, so the merged refund pot is 31.
	tbl.Seats[0] = &types.Seat{Player: "p0", Stack: 0, Hole: []uint32{255, 255}}
	tbl.Seats[1] = &types.Seat{Player: "p1", Stack: 0, Hole: []uint32{255, 255}}
	tbl.Seats[2] = &types.Seat{Player: "p2", Stack: 0, Hole: []uint32{255, 255}}
	tbl.Seats[3] = &types.Seat{Player: "p3", Stack: 0, Hole: []uint32{255, 255}}
	tbl.Hand.InHand[0] = true
	tbl.Hand.InHand[1] = true
	tbl.Hand.InHand[2] = true
	tbl.Hand.InHand[3] = true
	tbl.Hand.Folded[3] = true
	tbl.Hand.TotalCommit[0] = 10
	tbl.Hand.TotalCommit[1] = 10
	tbl.Hand.TotalCommit[2] = 10
	tbl.Hand.TotalCommit[3] = 1

	events, err := settleKnownShowdown(tbl)
	require.NoError(t, err)
	sum := tbl.Seats[0].Stack + tbl.Seats[1].Stack + tbl.Seats[2].Stack + tbl.Seats[3].Stack
	require.Equal(t, uint64(31), sum)
	require.Equal(t, uint64(0), tbl.Seats[3].Stack)
	// Merged pot of 31 splits across 3 eligibles -> share=10 each, remainder 1 goes to seat 0.
	require.Equal(t, uint64(11), tbl.Seats[0].Stack)
	require.Equal(t, uint64(10), tbl.Seats[1].Stack)
	require.Equal(t, uint64(10), tbl.Seats[2].Stack)
	require.Nil(t, tbl.Hand)

	refundCount := 0
	for _, e := range events {
		if e.Type == types.EventTypePotRefunded {
			refundCount++
		}
	}
	require.Equal(t, 1, refundCount, "expected one merged PotRefunded event")
}

func TestSettleKnownShowdown_LoneRevealedSeatWinsPot(t *testing.T) {
	tbl := newOverflowTestTable()
	// 3 eligible seats; only seat 1 has revealed hole cards (Ace high spade king).
	tbl.Seats[0] = &types.Seat{Player: "p0", Stack: 0, Hole: []uint32{255, 255}}
	// Seat 1 is the lone revealer with two non-sentinel hole cards (values are not evaluated).
	tbl.Seats[1] = &types.Seat{Player: "p1", Stack: 0, Hole: []uint32{50, 49}}
	tbl.Seats[2] = &types.Seat{Player: "p2", Stack: 0, Hole: []uint32{255, 255}}
	tbl.Hand.InHand[0] = true
	tbl.Hand.InHand[1] = true
	tbl.Hand.InHand[2] = true
	tbl.Hand.TotalCommit[0] = 10
	tbl.Hand.TotalCommit[1] = 10
	tbl.Hand.TotalCommit[2] = 10
	// Board cards are required to be valid (len>=5); their values are not evaluated by the fast-path.
	tbl.Hand.Board = []uint32{0, 1, 2, 3, 4}

	events, err := settleKnownShowdown(tbl)
	require.NoError(t, err)
	// Lone revealer (seat 1) takes the whole 30-chip pot.
	require.Equal(t, uint64(0), tbl.Seats[0].Stack)
	require.Equal(t, uint64(30), tbl.Seats[1].Stack)
	require.Equal(t, uint64(0), tbl.Seats[2].Stack)
	require.Nil(t, tbl.Hand)

	var hasAward bool
	for _, e := range events {
		if e.Type == types.EventTypePotAwarded {
			hasAward = true
			for _, a := range e.Attributes {
				if a.Key == "winners" {
					require.Equal(t, "1", a.Value)
				}
			}
		}
	}
	require.True(t, hasAward, "expected PotAwarded event")
}
