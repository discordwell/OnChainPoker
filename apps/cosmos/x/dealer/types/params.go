package types

import "fmt"

const (
	// MaxBps is 100% expressed in basis points.
	MaxBps uint32 = 10_000

	// maxJailSeconds is a sanity bound to avoid time.Duration overflow and
	// obviously-bad governance parameter values.
	maxJailSeconds uint64 = 365 * 24 * 60 * 60 // 1 year

	// DKG protocol versions. See docs/DKG-V2.md §6.
	DkgVersionV1 uint32 = 1 // plaintext reveals accepted (+ encrypted shares)
	DkgVersionV2 uint32 = 2 // only encrypted shares; plaintext rejected
)

func DefaultParams() Params {
	return Params{
		SlashBpsDkg:        5000, // 50%
		SlashBpsHandDealer: 1000, // 10%

		JailSecondsDkg:        24 * 60 * 60, // 24h
		JailSecondsHandDealer: 60 * 60,      // 1h

		// v1 keeps the legacy reveal path alive so existing daemons continue
		// to work. Governance flips to v2 once all dealers have migrated.
		DkgVersion: DkgVersionV1,
	}
}

// DkgVersionOrDefault treats a zero value as DkgVersionV1. This lets chains
// that haven't explicitly set the param (e.g. pre-upgrade state) behave as
// if the migration hasn't started, which is the safe default.
func (p Params) DkgVersionOrDefault() uint32 {
	if p.DkgVersion == 0 {
		return DkgVersionV1
	}
	return p.DkgVersion
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
	// dkg_version: 0 is tolerated (treated as v1 via DkgVersionOrDefault so
	// chains that upgrade without explicitly setting the param don't reject
	// their own state); 1 and 2 are the valid values.
	if p.DkgVersion > DkgVersionV2 {
		return fmt.Errorf("dkg_version must be 0 (legacy default), 1, or 2; got %d", p.DkgVersion)
	}
	return nil
}
