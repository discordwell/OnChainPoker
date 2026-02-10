package keeper

import (
	"context"

	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

type queryServer struct {
	Keeper
}

var _ dealertypes.QueryServer = queryServer{}

func NewQueryServerImpl(k Keeper) dealertypes.QueryServer {
	return &queryServer{Keeper: k}
}

func (q queryServer) Epoch(ctx context.Context, _ *dealertypes.QueryEpochRequest) (*dealertypes.QueryEpochResponse, error) {
	epoch, err := q.GetEpoch(ctx)
	if err != nil {
		return nil, err
	}
	return &dealertypes.QueryEpochResponse{Epoch: epoch}, nil
}

func (q queryServer) Dkg(ctx context.Context, _ *dealertypes.QueryDkgRequest) (*dealertypes.QueryDkgResponse, error) {
	dkg, err := q.GetDKG(ctx)
	if err != nil {
		return nil, err
	}
	return &dealertypes.QueryDkgResponse{Dkg: dkg}, nil
}

func (q queryServer) Hand(ctx context.Context, req *dealertypes.QueryHandRequest) (*dealertypes.QueryHandResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	hand, err := q.GetHand(ctx, req.TableId, req.HandId)
	if err != nil {
		return nil, err
	}
	return &dealertypes.QueryHandResponse{Hand: hand}, nil
}
