package committee

import (
	"context"
	"fmt"
	"sort"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

// MemberSnapshot captures the validator identity + power + consensus key bytes at selection time.
// This is useful for DKG committee membership and later slashing (power snapshots).
type MemberSnapshot struct {
	Operator   string
	Power      int64
	ConsPubKey []byte
}

// BondedMemberSnapshots returns snapshots for bonded validators with non-zero consensus power.
//
// Output is sorted ascending by operator address for canonical storage/indices.
func BondedMemberSnapshots(ctx context.Context, sk StakingKeeper) ([]MemberSnapshot, error) {
	if sk == nil {
		return nil, fmt.Errorf("staking keeper is nil")
	}

	vals, err := sk.GetBondedValidatorsByPower(ctx)
	if err != nil {
		return nil, err
	}

	out := make([]MemberSnapshot, 0, len(vals))
	seenOps := make(map[string]struct{}, len(vals))

	for _, v := range vals {
		op := v.GetOperator()
		if op == "" {
			continue
		}

		power := v.GetConsensusPower(sdk.DefaultPowerReduction)
		if power <= 0 {
			continue
		}

		if _, exists := seenOps[op]; exists {
			return nil, fmt.Errorf("duplicate validator operator: %s", op)
		}
		seenOps[op] = struct{}{}

		pk, err := v.ConsPubKey()
		if err != nil {
			return nil, err
		}

		consPk := pk.Bytes()
		if len(consPk) != 32 {
			return nil, fmt.Errorf("validator %s consensus pubkey is %d bytes, expected 32", op, len(consPk))
		}

		out = append(out, MemberSnapshot{
			Operator:   op,
			Power:      power,
			ConsPubKey: append([]byte(nil), consPk...),
		})
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Operator < out[j].Operator })
	return out, nil
}

// SampleBondedMemberSnapshotsByPower samples k bonded validators weighted by consensus power.
//
// Output is sorted ascending by operator address for canonical storage/indices.
func SampleBondedMemberSnapshotsByPower(ctx context.Context, sk StakingKeeper, seed [32]byte, k int) ([]MemberSnapshot, error) {
	all, err := BondedMemberSnapshots(ctx, sk)
	if err != nil {
		return nil, err
	}

	candidates := make([]PowerCandidate, 0, len(all))
	snapByOp := make(map[string]MemberSnapshot, len(all))
	for _, s := range all {
		candidates = append(candidates, PowerCandidate{Operator: s.Operator, Power: s.Power})
		snapByOp[s.Operator] = s
	}

	ops, err := SampleByPower(seed, candidates, k)
	if err != nil {
		return nil, err
	}

	out := make([]MemberSnapshot, 0, len(ops))
	for _, op := range ops {
		s, ok := snapByOp[op]
		if !ok {
			return nil, fmt.Errorf("selected operator not present in snapshots: %s", op)
		}
		out = append(out, s)
	}

	return out, nil
}
