package app

import (
	"context"
	"errors"

	upgradetypes "cosmossdk.io/x/upgrade/types"
)

// noopUpgradeKeeper satisfies ibc-go's clienttypes.UpgradeKeeper interface
// without adding the full x/upgrade module. IBC client upgrades via governance
// proposals are not supported on this chain (no x/gov, no x/upgrade).
type noopUpgradeKeeper struct{ sentinel int }

func (noopUpgradeKeeper) GetUpgradePlan(context.Context) (upgradetypes.Plan, error) {
	return upgradetypes.Plan{}, nil
}

func (noopUpgradeKeeper) GetUpgradedClient(context.Context, int64) ([]byte, error) {
	return nil, errors.New("upgrades not supported")
}

func (noopUpgradeKeeper) SetUpgradedClient(context.Context, int64, []byte) error {
	return errors.New("upgrades not supported")
}

func (noopUpgradeKeeper) GetUpgradedConsensusState(context.Context, int64) ([]byte, error) {
	return nil, errors.New("upgrades not supported")
}

func (noopUpgradeKeeper) SetUpgradedConsensusState(context.Context, int64, []byte) error {
	return errors.New("upgrades not supported")
}

func (noopUpgradeKeeper) ScheduleUpgrade(context.Context, upgradetypes.Plan) error {
	return errors.New("upgrades not supported")
}
