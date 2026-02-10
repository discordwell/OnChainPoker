package types

import "fmt"

func DefaultGenesisState() *GenesisState {
	return &GenesisState{
		NextTableId: 1,
		Tables:      nil,
	}
}

func ValidateGenesis(gs *GenesisState) error {
	if gs == nil {
		return fmt.Errorf("genesis state is nil")
	}
	if gs.NextTableId == 0 {
		return fmt.Errorf("next_table_id must be > 0")
	}
	seen := make(map[uint64]bool, len(gs.Tables))
	for _, t := range gs.Tables {
		if t.Id == 0 {
			return fmt.Errorf("table id must be > 0")
		}
		if seen[t.Id] {
			return fmt.Errorf("duplicate table id %d", t.Id)
		}
		seen[t.Id] = true
		if t.Id >= gs.NextTableId {
			return fmt.Errorf("table id %d >= next_table_id %d", t.Id, gs.NextTableId)
		}
	}
	return nil
}

