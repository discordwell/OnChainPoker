package types

import "fmt"

func DefaultGenesisState() *GenesisState {
	return &GenesisState{
		NextEpochId: 1,
		Epoch:       nil,
		Dkg:         nil,
		Params:      DefaultParams(),
	}
}

func ValidateGenesis(gs *GenesisState) error {
	if gs == nil {
		return fmt.Errorf("genesis state is nil")
	}
	if err := gs.Params.Validate(); err != nil {
		return fmt.Errorf("invalid params: %w", err)
	}
	if gs.NextEpochId == 0 {
		return fmt.Errorf("next_epoch_id must be > 0")
	}
	if gs.Epoch != nil {
		if gs.Epoch.EpochId == 0 {
			return fmt.Errorf("epoch_id must be > 0")
		}
	}
	if gs.Dkg != nil {
		if gs.Dkg.EpochId == 0 {
			return fmt.Errorf("dkg epoch_id must be > 0")
		}
		if gs.Dkg.EpochId >= gs.NextEpochId {
			return fmt.Errorf("dkg epoch_id %d >= next_epoch_id %d", gs.Dkg.EpochId, gs.NextEpochId)
		}
	}
	return nil
}
