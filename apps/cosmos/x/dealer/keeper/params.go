package keeper

import (
	"context"

	"onchainpoker/apps/cosmos/x/dealer/types"
)

func (k Keeper) GetParams(ctx context.Context) (types.Params, error) {
	store := k.storeService.OpenKVStore(ctx)
	bz, err := store.Get(types.ParamsKey)
	if err != nil {
		return types.Params{}, err
	}
	if bz == nil {
		return types.DefaultParams(), nil
	}
	var p types.Params
	if err := k.cdc.Unmarshal(bz, &p); err != nil {
		return types.Params{}, err
	}
	return p, nil
}

func (k Keeper) SetParams(ctx context.Context, p types.Params) error {
	if err := p.Validate(); err != nil {
		return err
	}
	store := k.storeService.OpenKVStore(ctx)
	bz, err := k.cdc.Marshal(&p)
	if err != nil {
		return err
	}
	return store.Set(types.ParamsKey, bz)
}
