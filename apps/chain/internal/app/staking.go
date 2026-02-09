package app

import (
	"fmt"
	"sort"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/codec"
	"onchainpoker/apps/chain/internal/state"
)

func stakingRegisterValidator(st *state.State, msg codec.StakingRegisterValidatorTx) (*abci.ExecTxResult, error) {
	if st == nil {
		return nil, fmt.Errorf("state is nil")
	}
	if st.Dealer == nil {
		st.Dealer = &state.DealerState{NextEpochID: 1}
	}
	id := msg.ValidatorID
	if id == "" {
		return nil, fmt.Errorf("missing validatorId")
	}
	for _, v := range st.Dealer.Validators {
		if v.ValidatorID == id {
			// Idempotent for localnet/scripts.
			return okEvent("ValidatorRegistered", map[string]string{
				"validatorId": id,
				"existing":    "true",
			}), nil
		}
	}
	st.Dealer.Validators = append(st.Dealer.Validators, state.Validator{
		ValidatorID: id,
		Power:       msg.Power,
		Status:      state.ValidatorActive,
	})
	sort.Slice(st.Dealer.Validators, func(i, j int) bool {
		return st.Dealer.Validators[i].ValidatorID < st.Dealer.Validators[j].ValidatorID
	})
	return okEvent("ValidatorRegistered", map[string]string{
		"validatorId": id,
	}), nil
}

func findValidator(st *state.State, validatorID string) *state.Validator {
	if st == nil || st.Dealer == nil {
		return nil
	}
	for i := range st.Dealer.Validators {
		if st.Dealer.Validators[i].ValidatorID == validatorID {
			return &st.Dealer.Validators[i]
		}
	}
	return nil
}
