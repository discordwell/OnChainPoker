package types

import (
	"context"
	"time"

	sdkmath "cosmossdk.io/math"

	sdk "github.com/cosmos/cosmos-sdk/types"
	slashingtypes "github.com/cosmos/cosmos-sdk/x/slashing/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"

	pokertypes "onchainpoker/apps/cosmos/x/poker/types"
)

// NOTE: keep these interfaces minimal; x/dealer should not depend on concrete keepers.

type StakingKeeper interface {
	Validator(ctx context.Context, addr sdk.ValAddress) (stakingtypes.ValidatorI, error)
	// GetBondedValidatorsByPower returns the active validator set, sorted by power.
	// Used for "don't brick the chain" guards when jailing.
	GetBondedValidatorsByPower(ctx context.Context) ([]stakingtypes.Validator, error)
}

type SlashingKeeper interface {
	// SlashWithInfractionReason delegates to staking to burn stake. The height param is the
	// "distribution height"/infraction height used by staking's slashing logic to decide which
	// unbonding delegations & redelegations are still slashable.
	SlashWithInfractionReason(
		ctx context.Context,
		consAddr sdk.ConsAddress,
		fraction sdkmath.LegacyDec,
		power int64,
		distributionHeight int64,
		infraction stakingtypes.Infraction,
	) error

	// Jail sets the validator's jailed flag in staking.
	Jail(ctx context.Context, consAddr sdk.ConsAddress) error

	// GetValidatorSigningInfo is used to read the current JailedUntil value so we can extend it.
	GetValidatorSigningInfo(ctx context.Context, consAddr sdk.ConsAddress) (slashingtypes.ValidatorSigningInfo, error)

	// JailUntil updates slashing signing info, which is enforced by MsgUnjail.
	JailUntil(ctx context.Context, consAddr sdk.ConsAddress, jailTime time.Time) error
}

// PokerKeeper is the minimal interface x/dealer needs to drive the poker state machine.
//
// Keep this interface small to avoid cross-module entanglement.
type PokerKeeper interface {
	GetTable(ctx context.Context, tableID uint64) (*pokertypes.Table, error)
	SetTable(ctx context.Context, t *pokertypes.Table) error

	// AbortHandRefundAllCommits clears the active hand and refunds committed chips to stacks.
	AbortHandRefundAllCommits(ctx context.Context, tableID, handID uint64, reason string) ([]sdk.Event, error)

	// ApplyDealerReveal applies a dealer reveal (board card or showdown hole card), and updates deadlines.
	ApplyDealerReveal(ctx context.Context, tableID, handID uint64, pos uint32, cardID uint32, nowUnix int64) ([]sdk.Event, error)

	// AdvanceAfterHoleSharesReady transitions out of SHUFFLE once encrypted hole shares are ready.
	AdvanceAfterHoleSharesReady(ctx context.Context, tableID, handID uint64, nowUnix int64) error
}
