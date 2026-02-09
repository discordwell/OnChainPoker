package app

import (
	"fmt"

	"onchainpoker/apps/chain/internal/state"
)

const defaultDealerTimeoutSecs uint64 = 120

func tableDealerTimeoutSecs(t *state.Table) uint64 {
	if t == nil {
		return defaultDealerTimeoutSecs
	}
	if t.Params.DealerTimeoutSecs == 0 {
		return defaultDealerTimeoutSecs
	}
	return t.Params.DealerTimeoutSecs
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
	dh.RevealDeadline = nowUnix + int64(to)
	return nil
}
