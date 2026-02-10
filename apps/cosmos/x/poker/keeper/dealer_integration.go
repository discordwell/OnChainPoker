package keeper

import (
	"context"
	"fmt"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"onchainpoker/apps/cosmos/x/poker/types"
)

// AbortHandRefundAllCommits clears the active hand and refunds any committed chips back to stacks.
//
// This is used by x/dealer to abort a hand when dealer duties fail and liveness cannot be recovered.
func (k Keeper) AbortHandRefundAllCommits(ctx context.Context, tableID, handID uint64, reason string) ([]sdk.Event, error) {
	t, err := k.GetTable(ctx, tableID)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, types.ErrTableNotFound.Wrapf("table %d not found", tableID)
	}
	if t.Hand == nil {
		return nil, types.ErrNoActiveHand.Wrap("no active hand")
	}
	if t.Hand.HandId != handID {
		return nil, types.ErrInvalidRequest.Wrap("hand_id mismatch")
	}
	if reason == "" {
		reason = "abort"
	}

	events := abortHandRefundAllCommits(t, reason)
	if err := k.SetTable(ctx, t); err != nil {
		return nil, err
	}
	return events, nil
}

func abortHandRefundAllCommits(t *types.Table, reason string) []sdk.Event {
	if t == nil || t.Hand == nil {
		return nil
	}
	h := t.Hand
	handID := h.HandId

	// Refund all committed chips and clear any public hole cards.
	for i := 0; i < 9; i++ {
		if t.Seats[i] == nil {
			continue
		}
		if i < len(h.TotalCommit) {
			t.Seats[i].Stack += h.TotalCommit[i]
		}
		t.Seats[i].Hole = []uint32{255, 255}
	}

	t.Hand = nil

	return []sdk.Event{
		sdk.NewEvent(
			types.EventTypeHandAborted,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", t.Id)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
			sdk.NewAttribute("reason", reason),
		),
	}
}

// ApplyDealerReveal applies a dealer reveal (board card or showdown hole card) to the poker state machine.
//
// It updates poker/dealer deadlines after applying the reveal and persists the table.
func (k Keeper) ApplyDealerReveal(ctx context.Context, tableID, handID uint64, pos uint32, cardID uint32, nowUnix int64) ([]sdk.Event, error) {
	t, err := k.GetTable(ctx, tableID)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, types.ErrTableNotFound.Wrapf("table %d not found", tableID)
	}
	if t.Hand == nil {
		return nil, types.ErrNoActiveHand.Wrap("no active hand")
	}
	if t.Hand.HandId != handID {
		return nil, types.ErrInvalidRequest.Wrap("hand_id mismatch")
	}
	if t.Hand.Dealer == nil {
		return nil, types.ErrInvalidRequest.Wrap("hand missing dealer meta")
	}

	events, err := applyDealerRevealToPoker(t, pos, cardID, nowUnix)
	if err != nil {
		return nil, err
	}

	// Update deadlines if the hand is still active.
	if t.Hand != nil {
		if err := setRevealDeadlineIfAwaiting(t, nowUnix); err != nil {
			return nil, err
		}
		if err := setActionDeadlineIfBetting(t, nowUnix); err != nil {
			return nil, err
		}
	}

	if err := k.SetTable(ctx, t); err != nil {
		return nil, err
	}
	return events, nil
}

// AdvanceAfterHoleSharesReady transitions a hand out of SHUFFLE once encrypted hole shares are ready.
//
// This is called by x/dealer after verifying threshold enc shares for all in-hand seats.
func (k Keeper) AdvanceAfterHoleSharesReady(ctx context.Context, tableID, handID uint64, nowUnix int64) error {
	t, err := k.GetTable(ctx, tableID)
	if err != nil {
		return err
	}
	if t == nil {
		return types.ErrTableNotFound.Wrapf("table %d not found", tableID)
	}
	if t.Hand == nil {
		return types.ErrNoActiveHand.Wrap("no active hand")
	}
	h := t.Hand
	if h.HandId != handID {
		return types.ErrInvalidRequest.Wrap("hand_id mismatch")
	}
	if h.Phase != types.HandPhase_HAND_PHASE_SHUFFLE {
		return types.ErrInvalidRequest.Wrap("hand not in shuffle phase")
	}
	if h.Dealer == nil || !h.Dealer.DeckFinalized {
		return types.ErrInvalidRequest.Wrap("dealer deck not finalized")
	}

	// Advance out of shuffle now that shares are ready.
	if h.ActionOn == -1 {
		h.Phase = types.HandPhase_HAND_PHASE_AWAIT_FLOP
		h.ActionOn = -1
	} else {
		h.Phase = types.HandPhase_HAND_PHASE_BETTING
	}

	if err := setRevealDeadlineIfAwaiting(t, nowUnix); err != nil {
		return err
	}
	if err := setActionDeadlineIfBetting(t, nowUnix); err != nil {
		return err
	}

	return k.SetTable(ctx, t)
}
