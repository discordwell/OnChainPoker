package keeper

import (
	"context"
	"errors"
	"fmt"
	"time"

	sdkmath "cosmossdk.io/math"

	sdk "github.com/cosmos/cosmos-sdk/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"

	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

// SlashAndJailValidator applies an application-level penalty to a validator.
//
// Key design point: pass a past "distributionHeight" (e.g. the DKG start height / obligation start height),
// plus the validator's consensus power *at that height*, so validators cannot avoid penalties by unbonding
// immediately after being selected for dealer duty.
func SlashAndJailValidator(
	ctx context.Context,
	stakingKeeper dealertypes.StakingKeeper,
	slashingKeeper dealertypes.SlashingKeeper,
	valAddr sdk.ValAddress,
	distributionHeight int64,
	powerAtDistributionHeight int64,
	slashFraction sdkmath.LegacyDec,
	jailDuration time.Duration,
) error {
	validator, err := stakingKeeper.Validator(ctx, valAddr)
	if err != nil {
		return err
	}
	if validator == nil {
		return fmt.Errorf("validator not found: %s", valAddr.String())
	}

	consBz, err := validator.GetConsAddr()
	if err != nil {
		return err
	}
	consAddr := sdk.ConsAddress(consBz)

	if slashFraction.IsNegative() {
		return fmt.Errorf("invalid slash fraction (negative): %s", slashFraction)
	}

	// Slash first, then jail. (Consensus modules do slash+jail together; order here is not critical,
	// but slashing first avoids edge cases where jailing changes validator power indexes mid-flow.)
	if slashFraction.IsPositive() {
		if err := slashingKeeper.SlashWithInfractionReason(
			ctx,
			consAddr,
			slashFraction,
			powerAtDistributionHeight,
			distributionHeight,
			stakingtypes.Infraction_INFRACTION_UNSPECIFIED,
		); err != nil {
			return err
		}
	}

	// Jail is not idempotent; skip if already jailed, and treat "already jailed" as success.
	//
	// IMPORTANT: in a single-validator network, jailing the only bonded validator would
	// make the validator set empty and CometBFT will panic. Skip jailing in that case.
	bonded, err := stakingKeeper.GetBondedValidatorsByPower(ctx)
	if err == nil && len(bonded) == 1 && bonded[0].GetOperator() == valAddr.String() {
		// Still allow slashing, but do not jail.
		return nil
	}

	if !validator.IsJailed() {
		if err := slashingKeeper.Jail(ctx, consAddr); err != nil && !errors.Is(err, stakingtypes.ErrValidatorJailed) {
			return err
		}
	}

	// Optionally extend jail time (enforced by MsgUnjail in x/slashing).
	if jailDuration > 0 {
		sdkCtx := sdk.UnwrapSDKContext(ctx)
		newUntil := sdkCtx.BlockTime().Add(jailDuration)

		info, err := slashingKeeper.GetValidatorSigningInfo(ctx, consAddr)
		if err == nil {
			// Never shorten an existing jail.
			if info.JailedUntil.Before(newUntil) {
				if err := slashingKeeper.JailUntil(ctx, consAddr, newUntil); err != nil {
					return err
				}
			}
		} else {
			// If signing info doesn't exist, JailUntil will fail anyway; surface the error so
			// the caller can decide if this should be fatal.
			return err
		}
	}

	return nil
}
