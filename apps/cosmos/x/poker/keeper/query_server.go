package keeper

import (
	"context"
	"fmt"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"onchainpoker/apps/cosmos/x/poker/types"
)

type queryServer struct {
	Keeper
}

var _ types.QueryServer = queryServer{}

func NewQueryServerImpl(k Keeper) types.QueryServer {
	return &queryServer{Keeper: k}
}

func (q queryServer) Table(ctx context.Context, req *types.QueryTableRequest) (*types.QueryTableResponse, error) {
	if req == nil {
		return nil, types.ErrInvalidRequest.Wrap("nil request")
	}
	t, err := q.GetTable(ctx, req.TableId)
	if err != nil {
		return nil, err
	}
	if t == nil {
		return nil, types.ErrTableNotFound.Wrapf("table %d not found", req.TableId)
	}
	return &types.QueryTableResponse{Table: *t}, nil
}

func (q queryServer) Tables(ctx context.Context, _ *types.QueryTablesRequest) (*types.QueryTablesResponse, error) {
	ids := make([]uint64, 0)
	if err := q.IterateTables(ctx, func(id uint64) bool {
		ids = append(ids, id)
		return false
	}); err != nil {
		return nil, err
	}
	return &types.QueryTablesResponse{TableIds: ids}, nil
}

// Query helpers (used by other modules / tests).
func (k Keeper) MustGetTable(ctx context.Context, tableID uint64) *types.Table {
	t, err := k.GetTable(ctx, tableID)
	if err != nil {
		panic(err)
	}
	if t == nil {
		panic(fmt.Sprintf("table %d not found", tableID))
	}
	return t
}

// Assert module compiles with sdk.Context unwrap.
var _ = sdk.UnwrapSDKContext
