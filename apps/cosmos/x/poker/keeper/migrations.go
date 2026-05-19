package keeper

import (
	"fmt"

	sdk "github.com/cosmos/cosmos-sdk/types"
)

// Migrator provides the upgrade handlers for the x/poker module. New
// migrations should be added as Migrate{N}to{N+1} methods and registered in
// module.go's RegisterServices.
type Migrator struct {
	keeper Keeper
}

// NewMigrator constructs a Migrator over the given keeper.
func NewMigrator(k Keeper) Migrator {
	return Migrator{keeper: k}
}

// Migrate1to2 lifts x/poker from ConsensusVersion 1 to 2. The on-disk schema
// change is proto3-additive: TableParams.password_salt is a new field that
// defaults to empty bytes on existing rows, and the chain treats legacy
// tables (empty salt) as still using the unsalted SHA256(password) hash.
// This handler exists to (a) stand up RegisterMigration scaffolding for
// future schema changes and (b) emit an audit log of the migration.
//
// It iterates all tables and counts how many already have a non-empty
// password_hash so operators have a starting baseline. Nothing is rewritten.
func (m Migrator) Migrate1to2(ctx sdk.Context) error {
	gctx := sdk.WrapSDKContext(ctx)
	var (
		total     uint64
		withPwd   uint64
	)
	if err := m.keeper.IterateTables(gctx, func(id uint64) bool {
		total++
		t, err := m.keeper.GetTable(gctx, id)
		if err != nil || t == nil {
			return false
		}
		if len(t.Params.PasswordHash) > 0 {
			withPwd++
		}
		return false
	}); err != nil {
		return fmt.Errorf("poker migrate v1->v2: iterate tables: %w", err)
	}
	ctx.Logger().Info(
		"x/poker migrated to v2 (password commitment + salt)",
		"tables", total,
		"password_protected", withPwd,
	)
	return nil
}
