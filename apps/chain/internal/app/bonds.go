package app

import (
	"fmt"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/state"
)

// Eject any seated players whose bond has been depleted. This is a simple v0
// anti-grief mechanism: once a player burns through their bond via timeouts,
// they are removed between hands and their remaining stack is returned to their
// bank balance.
func ejectBondlessSeats(st *state.State, t *state.Table) []abci.Event {
	if st == nil || t == nil {
		return nil
	}
	if t.Hand != nil {
		return nil
	}
	if t.Params.PlayerBond == 0 {
		return nil
	}

	events := []abci.Event{}
	for i := 0; i < 9; i++ {
		s := t.Seats[i]
		if s == nil || s.Player == "" {
			continue
		}
		if s.Bond != 0 {
			continue
		}

		st.Credit(s.Player, s.Stack)
		events = append(events, abci.Event{
			Type: "PlayerEjected",
			Attributes: []abci.EventAttribute{
				{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
				{Key: "seat", Value: fmt.Sprintf("%d", i), Index: true},
				{Key: "player", Value: s.Player, Index: true},
				{Key: "reason", Value: "bond depleted", Index: false},
				{Key: "stackReturned", Value: fmt.Sprintf("%d", s.Stack), Index: false},
			},
		})
		t.Seats[i] = nil
	}
	return events
}
