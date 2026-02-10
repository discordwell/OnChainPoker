package module

import (
	"context"
	"encoding/json"
	"fmt"

	gwruntime "github.com/grpc-ecosystem/grpc-gateway/runtime"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"

	"onchainpoker/apps/cosmos/x/poker/keeper"
	"onchainpoker/apps/cosmos/x/poker/types"
)

var (
	_ module.AppModuleBasic = AppModule{}
	_ module.AppModule      = AppModule{}
	_ module.HasServices    = AppModule{}
	_ module.HasGenesis     = AppModule{}
)

// AppModuleBasic defines the basic application module used by x/poker.
type AppModuleBasic struct{}

func (AppModuleBasic) Name() string { return types.ModuleName }

func (AppModuleBasic) RegisterLegacyAminoCodec(cdc *codec.LegacyAmino) {
	types.RegisterLegacyAminoCodec(cdc)
}

func (AppModuleBasic) RegisterInterfaces(registry codectypes.InterfaceRegistry) {
	types.RegisterInterfaces(registry)
}

// RegisterGRPCGatewayRoutes registers the gRPC Gateway routes for the poker module.
func (AppModuleBasic) RegisterGRPCGatewayRoutes(clientCtx client.Context, mux *gwruntime.ServeMux) {
	if err := types.RegisterQueryHandlerClient(context.Background(), mux, types.NewQueryClient(clientCtx)); err != nil {
		panic(err)
	}
}

func (AppModuleBasic) DefaultGenesis(cdc codec.JSONCodec) json.RawMessage {
	return cdc.MustMarshalJSON(types.DefaultGenesisState())
}

func (AppModuleBasic) ValidateGenesis(cdc codec.JSONCodec, _ client.TxEncodingConfig, bz json.RawMessage) error {
	var gs types.GenesisState
	if err := cdc.UnmarshalJSON(bz, &gs); err != nil {
		return err
	}
	return types.ValidateGenesis(&gs)
}

// AppModule implements the Cosmos SDK module interfaces for x/poker.
type AppModule struct {
	AppModuleBasic

	cdc    codec.Codec
	keeper keeper.Keeper
}

func NewAppModule(cdc codec.Codec, k keeper.Keeper) AppModule {
	return AppModule{AppModuleBasic: AppModuleBasic{}, cdc: cdc, keeper: k}
}

// IsOnePerModuleType implements depinject.OnePerModuleType.
func (AppModule) IsOnePerModuleType() {}

// IsAppModule implements appmodule.AppModule.
func (AppModule) IsAppModule() {}

func (am AppModule) RegisterServices(cfg module.Configurator) {
	types.RegisterMsgServer(cfg.MsgServer(), keeper.NewMsgServerImpl(am.keeper, am.cdc))
	types.RegisterQueryServer(cfg.QueryServer(), keeper.NewQueryServerImpl(am.keeper))
}

func (am AppModule) InitGenesis(ctx sdk.Context, cdc codec.JSONCodec, data json.RawMessage) {
	gctx := sdk.WrapSDKContext(ctx)

	var gs types.GenesisState
	if len(data) == 0 {
		gs = *types.DefaultGenesisState()
	} else {
		cdc.MustUnmarshalJSON(data, &gs)
	}

	if err := types.ValidateGenesis(&gs); err != nil {
		panic(fmt.Errorf("x/poker invalid genesis: %w", err))
	}

	if err := am.keeper.SetNextTableID(gctx, gs.NextTableId); err != nil {
		panic(err)
	}
	for _, t := range gs.Tables {
		tt := t
		if err := am.keeper.SetTable(gctx, &tt); err != nil {
			panic(err)
		}
	}
}

func (am AppModule) ExportGenesis(ctx sdk.Context, cdc codec.JSONCodec) json.RawMessage {
	gctx := sdk.WrapSDKContext(ctx)

	next, err := am.keeper.GetNextTableID(gctx)
	if err != nil {
		panic(err)
	}

	var tables []types.Table
	if err := am.keeper.IterateTables(gctx, func(id uint64) bool {
		t, err2 := am.keeper.GetTable(gctx, id)
		if err2 != nil {
			panic(err2)
		}
		if t != nil {
			tables = append(tables, *t)
		}
		return false
	}); err != nil {
		panic(err)
	}

	gs := types.GenesisState{
		NextTableId: next,
		Tables:      tables,
	}
	return cdc.MustMarshalJSON(&gs)
}

func (AppModule) ConsensusVersion() uint64 { return 1 }
