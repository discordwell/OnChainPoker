package app

import (
	"fmt"

	"onchainpoker/apps/chain/internal/state"
)

const defaultDealerTimeoutSecs uint64 = 120
const defaultActionTimeoutSecs uint64 = 30

func tableDealerTimeoutSecs(t *state.Table) uint64 {
	if t == nil {
		return defaultDealerTimeoutSecs
	}
	if t.Params.DealerTimeoutSecs == 0 {
		return defaultDealerTimeoutSecs
	}
	return t.Params.DealerTimeoutSecs
}

func tableActionTimeoutSecs(t *state.Table) uint64 {
	if t == nil {
		return defaultActionTimeoutSecs
	}
	if t.Params.ActionTimeoutSecs == 0 {
		return defaultActionTimeoutSecs
	}
	return t.Params.ActionTimeoutSecs
}

func setRevealDeadlineIfAwaiting(t *state.Table, nowUnix int64) error {
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil
	}
	dh := t.Hand.Dealer

	pos, awaiting, err := dealerExpectedRevealPos(t)
	if err != nil {
		return err
	}
	if !awaiting {
		dh.RevealPos = 255
		dh.RevealDeadline = 0
		return nil
	}

	to := tableDealerTimeoutSecs(t)
	if to == 0 {
		return fmt.Errorf("invalid dealerTimeoutSecs")
	}
	dh.RevealPos = pos
	deadline, err := addInt64AndU64Checked(nowUnix, to, "reveal deadline")
	if err != nil {
		return err
	}
	dh.RevealDeadline = deadline
	return nil
}

func setActionDeadlineIfBetting(t *state.Table, nowUnix int64) error {
	if t == nil || t.Hand == nil {
		return nil
	}
	h := t.Hand

	// Clear deadline outside of betting (no player action).
	if h.Phase != state.PhaseBetting || h.ActionOn < 0 || h.ActionOn >= 9 {
		h.ActionDeadline = 0
		return nil
	}

	to := tableActionTimeoutSecs(t)
	if to == 0 {
		return fmt.Errorf("invalid actionTimeoutSecs")
	}
	deadline, err := addInt64AndU64Checked(nowUnix, to, "action deadline")
	if err != nil {
		return err
	}
	h.ActionDeadline = deadline
	return nil
}
