package app

import (
	"bytes"
	"crypto/ed25519"
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
	if len(msg.PubKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("pubKey must be %d bytes", ed25519.PublicKeySize)
	}
	for i := range st.Dealer.Validators {
		v := &st.Dealer.Validators[i]
		if v.ValidatorID == id {
			// Idempotent for localnet/scripts. Power can be updated. PubKey must match.
			if len(v.PubKey) != 0 && !bytes.Equal(v.PubKey, msg.PubKey) {
				return nil, fmt.Errorf("validator pubKey mismatch for %q", id)
			}
			if len(v.PubKey) == 0 {
				v.PubKey = append([]byte(nil), msg.PubKey...)
			}
			if msg.Power != 0 {
				v.Power = msg.Power
			}
			return okEvent("ValidatorRegistered", map[string]string{
				"validatorId": id,
				"existing":    "true",
			}), nil
		}
	}
	st.Dealer.Validators = append(st.Dealer.Validators, state.Validator{
		ValidatorID: id,
		PubKey:      append([]byte(nil), msg.PubKey...),
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

func stakingBond(st *state.State, msg codec.StakingBondTx) (*abci.ExecTxResult, error) {
	if st == nil {
		return nil, fmt.Errorf("state is nil")
	}
	id := msg.ValidatorID
	if id == "" {
		return nil, fmt.Errorf("missing validatorId")
	}
	if msg.Amount == 0 {
		return nil, fmt.Errorf("amount must be > 0")
	}
	v := findValidator(st, id)
	if v == nil {
		return nil, fmt.Errorf("validator not registered")
	}
	if err := st.Debit(id, msg.Amount); err != nil {
		return nil, err
	}
	v.Bond += msg.Amount
	return okEvent("ValidatorBonded", map[string]string{
		"validatorId": id,
		"amount":      fmt.Sprintf("%d", msg.Amount),
		"bond":        fmt.Sprintf("%d", v.Bond),
	}), nil
}

func stakingUnbond(st *state.State, msg codec.StakingUnbondTx) (*abci.ExecTxResult, error) {
	if st == nil {
		return nil, fmt.Errorf("state is nil")
	}
	id := msg.ValidatorID
	if id == "" {
		return nil, fmt.Errorf("missing validatorId")
	}
	if msg.Amount == 0 {
		return nil, fmt.Errorf("amount must be > 0")
	}
	v := findValidator(st, id)
	if v == nil {
		return nil, fmt.Errorf("validator not registered")
	}
	if v.Bond < msg.Amount {
		return nil, fmt.Errorf("insufficient bond: have=%d need=%d", v.Bond, msg.Amount)
	}
	v.Bond -= msg.Amount
	st.Credit(id, msg.Amount)
	return okEvent("ValidatorUnbonded", map[string]string{
		"validatorId": id,
		"amount":      fmt.Sprintf("%d", msg.Amount),
		"bond":        fmt.Sprintf("%d", v.Bond),
	}), nil
}

func stakingUnjail(st *state.State, msg codec.StakingUnjailTx) (*abci.ExecTxResult, error) {
	if st == nil {
		return nil, fmt.Errorf("state is nil")
	}
	id := msg.ValidatorID
	if id == "" {
		return nil, fmt.Errorf("missing validatorId")
	}
	v := findValidator(st, id)
	if v == nil {
		return nil, fmt.Errorf("validator not registered")
	}
	if v.Status != state.ValidatorJailed {
		return nil, fmt.Errorf("validator is not jailed")
	}
	v.Status = state.ValidatorActive
	return okEvent("ValidatorUnjailed", map[string]string{
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
