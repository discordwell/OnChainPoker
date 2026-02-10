package keeper

import (
	"context"
	"encoding/binary"
	"fmt"

	"cosmossdk.io/core/store"
	"cosmossdk.io/log"

	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types"

	"onchainpoker/apps/cosmos/x/dealer/committee"
	"onchainpoker/apps/cosmos/x/dealer/types"
)

type Keeper struct {
	storeService store.KVStoreService
	cdc          codec.BinaryCodec

	authority string

	stakingKeeper          types.StakingKeeper
	committeeStakingKeeper committee.StakingKeeper
	slashingKeeper         types.SlashingKeeper

	pokerKeeper types.PokerKeeper
}

func NewKeeper(
	cdc codec.BinaryCodec,
	storeService store.KVStoreService,
	authority string,
	stakingKeeper types.StakingKeeper,
	committeeStakingKeeper committee.StakingKeeper,
	slashingKeeper types.SlashingKeeper,
	pokerKeeper types.PokerKeeper,
) Keeper {
	if cdc == nil {
		panic("dealer keeper: cdc is nil")
	}
	if storeService == nil {
		panic("dealer keeper: store service is nil")
	}
	if authority == "" {
		panic("dealer keeper: authority is empty")
	}
	if stakingKeeper == nil {
		panic("dealer keeper: staking keeper is nil")
	}
	if committeeStakingKeeper == nil {
		panic("dealer keeper: committee staking keeper is nil")
	}
	if slashingKeeper == nil {
		panic("dealer keeper: slashing keeper is nil")
	}
	if pokerKeeper == nil {
		panic("dealer keeper: poker keeper is nil")
	}
	return Keeper{
		storeService:           storeService,
		cdc:                    cdc,
		authority:              authority,
		stakingKeeper:          stakingKeeper,
		committeeStakingKeeper: committeeStakingKeeper,
		slashingKeeper:         slashingKeeper,
		pokerKeeper:            pokerKeeper,
	}
}

func (k Keeper) Logger(ctx context.Context) log.Logger {
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	return sdkCtx.Logger().With("module", "x/"+types.ModuleName)
}

// ---- Epoch / DKG state ----

func (k Keeper) GetNextEpochID(ctx context.Context) (uint64, error) {
	store := k.storeService.OpenKVStore(ctx)
	bz, err := store.Get(types.NextEpochIDKey)
	if err != nil {
		return 0, err
	}
	if bz == nil {
		return 1, nil
	}
	if len(bz) != 8 {
		return 0, fmt.Errorf("invalid nextEpochID encoding")
	}
	return binary.BigEndian.Uint64(bz), nil
}

func (k Keeper) SetNextEpochID(ctx context.Context, next uint64) error {
	store := k.storeService.OpenKVStore(ctx)
	bz := make([]byte, 8)
	binary.BigEndian.PutUint64(bz, next)
	return store.Set(types.NextEpochIDKey, bz)
}

func (k Keeper) GetEpoch(ctx context.Context) (*types.DealerEpoch, error) {
	store := k.storeService.OpenKVStore(ctx)
	bz, err := store.Get(types.EpochKey)
	if err != nil {
		return nil, err
	}
	if bz == nil {
		return nil, nil
	}
	var e types.DealerEpoch
	if err := k.cdc.Unmarshal(bz, &e); err != nil {
		return nil, err
	}
	return &e, nil
}

func (k Keeper) SetEpoch(ctx context.Context, e *types.DealerEpoch) error {
	store := k.storeService.OpenKVStore(ctx)
	if e == nil {
		return store.Delete(types.EpochKey)
	}
	bz, err := k.cdc.Marshal(e)
	if err != nil {
		return err
	}
	return store.Set(types.EpochKey, bz)
}

func (k Keeper) GetDKG(ctx context.Context) (*types.DealerDKG, error) {
	store := k.storeService.OpenKVStore(ctx)
	bz, err := store.Get(types.DKGKey)
	if err != nil {
		return nil, err
	}
	if bz == nil {
		return nil, nil
	}
	var d types.DealerDKG
	if err := k.cdc.Unmarshal(bz, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

func (k Keeper) SetDKG(ctx context.Context, d *types.DealerDKG) error {
	store := k.storeService.OpenKVStore(ctx)
	if d == nil {
		return store.Delete(types.DKGKey)
	}
	bz, err := k.cdc.Marshal(d)
	if err != nil {
		return err
	}
	return store.Set(types.DKGKey, bz)
}

// ---- Hand state ----

func (k Keeper) GetHand(ctx context.Context, tableID, handID uint64) (*types.DealerHand, error) {
	store := k.storeService.OpenKVStore(ctx)
	bz, err := store.Get(types.HandKey(tableID, handID))
	if err != nil {
		return nil, err
	}
	if bz == nil {
		return nil, nil
	}
	var h types.DealerHand
	if err := k.cdc.Unmarshal(bz, &h); err != nil {
		return nil, err
	}
	return &h, nil
}

func (k Keeper) SetHand(ctx context.Context, tableID, handID uint64, h *types.DealerHand) error {
	store := k.storeService.OpenKVStore(ctx)
	if h == nil {
		return store.Delete(types.HandKey(tableID, handID))
	}
	bz, err := k.cdc.Marshal(h)
	if err != nil {
		return err
	}
	return store.Set(types.HandKey(tableID, handID), bz)
}
