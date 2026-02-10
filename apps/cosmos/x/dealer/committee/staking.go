package committee

import (
	"context"
	"fmt"
	"sort"

	sdk "github.com/cosmos/cosmos-sdk/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
)

// StakingKeeper is the minimal interface x/dealer needs for committee sampling.
type StakingKeeper interface {
	GetBondedValidatorsByPower(ctx context.Context) ([]stakingtypes.Validator, error)
}

// BondedPowerCandidates returns all bonded validators (i.e., the active set),
// along with their current consensus power (used as the committee sampling weight).
//
// Candidates are sorted by operator address to ensure deterministic iteration
// independent of staking's internal store iteration order.
func BondedPowerCandidates(ctx context.Context, sk StakingKeeper) ([]PowerCandidate, error) {
	if sk == nil {
		return nil, fmt.Errorf("staking keeper is nil")
	}

	vals, err := sk.GetBondedValidatorsByPower(ctx)
	if err != nil {
		return nil, err
	}

	out := make([]PowerCandidate, 0, len(vals))
	for _, v := range vals {
		op := v.GetOperator()
		if op == "" {
			continue
		}

		power := v.GetConsensusPower(sdk.DefaultPowerReduction)
		if power <= 0 {
			continue
		}

		out = append(out, PowerCandidate{
			Operator: op,
			Power:    power,
		})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Operator < out[j].Operator })
	return out, nil
}

// SampleBondedValidatorsByPower samples k validator operator addresses from the
// bonded validator set, weighted by consensus power.
func SampleBondedValidatorsByPower(ctx context.Context, sk StakingKeeper, seed [32]byte, k int) ([]string, error) {
	candidates, err := BondedPowerCandidates(ctx, sk)
	if err != nil {
		return nil, err
	}
	return SampleByPower(seed, candidates, k)
}

// SampleBondedMembersByPower samples k bonded validators weighted by consensus power.
// It returns the selected operator addresses along with their power at selection time.
func SampleBondedMembersByPower(ctx context.Context, sk StakingKeeper, seed [32]byte, k int) ([]PowerCandidate, error) {
	candidates, err := BondedPowerCandidates(ctx, sk)
	if err != nil {
		return nil, err
	}
	return SampleCandidatesByPower(seed, candidates, k)
}
