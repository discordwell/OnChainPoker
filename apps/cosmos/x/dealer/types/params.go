package types

import "fmt"

const (
	// MaxBps is 100% expressed in basis points.
	MaxBps uint32 = 10_000

	// maxJailSeconds is a sanity bound to avoid time.Duration overflow and
	// obviously-bad governance parameter values.
	maxJailSeconds uint64 = 365 * 24 * 60 * 60 // 1 year
)

func DefaultParams() Params {
	return Params{
		SlashBpsDkg:        5000, // 50%
		SlashBpsHandDealer: 1000, // 10%

		JailSecondsDkg:        24 * 60 * 60, // 24h
		JailSecondsHandDealer: 60 * 60,      // 1h
	}
}

func (p Params) Validate() error {
	if p.SlashBpsDkg > MaxBps {
		return fmt.Errorf("slash_bps_dkg must be <= %d", MaxBps)
	}
	if p.SlashBpsHandDealer > MaxBps {
		return fmt.Errorf("slash_bps_hand_dealer must be <= %d", MaxBps)
	}
	if p.JailSecondsDkg > maxJailSeconds {
		return fmt.Errorf("jail_seconds_dkg too large: %d > %d", p.JailSecondsDkg, maxJailSeconds)
	}
	if p.JailSecondsHandDealer > maxJailSeconds {
		return fmt.Errorf("jail_seconds_hand_dealer too large: %d > %d", p.JailSecondsHandDealer, maxJailSeconds)
	}
	return nil
}
