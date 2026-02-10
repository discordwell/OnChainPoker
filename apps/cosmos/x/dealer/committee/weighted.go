package committee

import (
	"fmt"
	"math/big"
	"sort"
)

// PowerCandidate is an eligible validator for committee sampling.
// Operator is the bech32 validator operator address (valoper...).
// Power is the consensus power used for weighting (must be > 0).
type PowerCandidate struct {
	Operator string
	Power    int64
}

type weightedCandidate struct {
	operator string
	weight   *big.Int
}

// SampleByPower samples k distinct operators from candidates, weighted by Power.
// Output is sorted ascending for canonical storage/indices.
func SampleByPower(seed [32]byte, candidates []PowerCandidate, k int) ([]string, error) {
	if k < 0 {
		return nil, fmt.Errorf("k must be >= 0")
	}
	if k == 0 {
		return []string{}, nil
	}

	pool := make([]weightedCandidate, 0, len(candidates))
	total := big.NewInt(0)
	seenOps := make(map[string]struct{}, len(candidates))
	for _, c := range candidates {
		if c.Operator == "" {
			return nil, fmt.Errorf("candidate operator address is empty")
		}
		if c.Power <= 0 {
			continue
		}
		if _, exists := seenOps[c.Operator]; exists {
			return nil, fmt.Errorf("duplicate candidate operator: %s", c.Operator)
		}
		seenOps[c.Operator] = struct{}{}

		w := big.NewInt(c.Power)
		pool = append(pool, weightedCandidate{
			operator: c.Operator,
			weight:   w,
		})
		total.Add(total, w)
	}

	if len(pool) < k {
		return nil, fmt.Errorf("not enough eligible candidates: have %d need %d", len(pool), k)
	}

	rng := newHashRNG(seed)
	selected := make([]string, 0, k)

	var cum big.Int
	for i := 0; i < k; i++ {
		if total.Sign() <= 0 {
			return nil, fmt.Errorf("internal error: total weight became non-positive")
		}

		r, err := rng.BigIntn(total)
		if err != nil {
			return nil, err
		}

		cum.SetInt64(0)
		pick := -1
		for j := range pool {
			cum.Add(&cum, pool[j].weight)
			if cum.Cmp(r) == 1 { // cum > r
				pick = j
				break
			}
		}
		if pick < 0 {
			return nil, fmt.Errorf("internal error: failed to pick candidate")
		}

		selected = append(selected, pool[pick].operator)
		total.Sub(total, pool[pick].weight)

		// Remove picked element (swap-remove).
		last := len(pool) - 1
		pool[pick] = pool[last]
		pool = pool[:last]
	}

	sort.Strings(selected)
	return selected, nil
}

// SampleCandidatesByPower samples k distinct candidates, weighted by Power.
// Output is sorted ascending by operator for canonical storage/indices.
func SampleCandidatesByPower(seed [32]byte, candidates []PowerCandidate, k int) ([]PowerCandidate, error) {
	ops, err := SampleByPower(seed, candidates, k)
	if err != nil {
		return nil, err
	}

	powerByOp := make(map[string]int64, len(candidates))
	for _, c := range candidates {
		if c.Operator == "" {
			return nil, fmt.Errorf("candidate operator address is empty")
		}
		if c.Power <= 0 {
			continue
		}
		if _, exists := powerByOp[c.Operator]; exists {
			return nil, fmt.Errorf("duplicate candidate operator: %s", c.Operator)
		}
		powerByOp[c.Operator] = c.Power
	}

	out := make([]PowerCandidate, 0, len(ops))
	for _, op := range ops {
		p, ok := powerByOp[op]
		if !ok {
			return nil, fmt.Errorf("selected operator not present in candidates: %s", op)
		}
		out = append(out, PowerCandidate{Operator: op, Power: p})
	}

	return out, nil
}
