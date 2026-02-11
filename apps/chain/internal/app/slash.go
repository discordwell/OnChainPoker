package app

import (
	"math/bits"

	"onchainpoker/apps/chain/internal/state"
)

const (
	treasuryAccount = "ocp/treasury"

	// v0 economics: these are placeholders while we iterate on incentives.
	slashBpsDKG        uint32 = 5000 // 50%
	slashBpsHandDealer uint32 = 1000 // 10%
)

func slashAmount(bond uint64, bps uint32) uint64 {
	if bond == 0 || bps == 0 {
		return 0
	}
	hi, lo := bits.Mul64(bond, uint64(bps))
	q, r := bits.Div64(hi, lo, 10000)
	if r != 0 {
		q++
	}
	if q > bond {
		return bond
	}
	return q
}

func jailAndSlashValidator(st *state.State, validatorID string, bps uint32) (uint64, error) {
	if st == nil || validatorID == "" {
		return 0, nil
	}
	v := findValidator(st, validatorID)
	if v == nil {
		return 0, nil
	}

	amt := slashAmount(v.Bond, bps)
	if amt > 0 {
		v.Bond -= amt
		if err := st.Credit(treasuryAccount, amt); err != nil {
			return 0, err
		}
	}
	if v.Status != state.ValidatorJailed {
		v.Status = state.ValidatorJailed
	}
	v.SlashCount++
	return amt, nil
}
