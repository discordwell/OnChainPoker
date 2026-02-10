package dealer

import (
	"context"
	"encoding/json"
	"fmt"

	gwruntime "github.com/grpc-ecosystem/grpc-gateway/runtime"

	modulev1 "onchainpoker/apps/cosmos/x/dealer/module/v1"

	"cosmossdk.io/core/appmodule"
	corestore "cosmossdk.io/core/store"
	"cosmossdk.io/depinject"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"

	"onchainpoker/apps/cosmos/x/dealer/committee"
	"onchainpoker/apps/cosmos/x/dealer/keeper"
	"onchainpoker/apps/cosmos/x/dealer/types"
)

// ConsensusVersion defines the current x/dealer module consensus version.
const ConsensusVersion = 1

var (
	_ module.AppModuleBasic = AppModule{}
	_ module.HasServices    = AppModule{}
	_ module.HasGenesis     = AppModule{}

	_ appmodule.AppModule = AppModule{}
)

// AppModuleBasic defines the basic application module used by x/dealer.
type AppModuleBasic struct{}

func (AppModuleBasic) Name() string { return types.ModuleName }

func (AppModuleBasic) RegisterLegacyAminoCodec(cdc *codec.LegacyAmino) {
	types.RegisterLegacyAminoCodec(cdc)
}

func (AppModuleBasic) RegisterInterfaces(registry codectypes.InterfaceRegistry) {
	types.RegisterInterfaces(registry)
}

// RegisterGRPCGatewayRoutes registers the gRPC Gateway routes for the dealer module.
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

// AppModule implements an application module for x/dealer.
type AppModule struct {
	AppModuleBasic

	cdc    codec.Codec
	keeper keeper.Keeper
}

func NewAppModule(cdc codec.Codec, k keeper.Keeper) AppModule {
	return AppModule{AppModuleBasic: AppModuleBasic{}, cdc: cdc, keeper: k}
}

func (AppModule) IsOnePerModuleType() {}
func (AppModule) IsAppModule()        {}

func (am AppModule) RegisterServices(cfg module.Configurator) {
	types.RegisterMsgServer(cfg.MsgServer(), keeper.NewMsgServerImpl(am.keeper))
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
		panic(fmt.Errorf("x/dealer invalid genesis: %w", err))
	}

	if err := am.keeper.SetNextEpochID(gctx, gs.NextEpochId); err != nil {
		panic(err)
	}
	if err := am.keeper.SetEpoch(gctx, gs.Epoch); err != nil {
		panic(err)
	}
	if err := am.keeper.SetDKG(gctx, gs.Dkg); err != nil {
		panic(err)
	}
}

func (am AppModule) ExportGenesis(ctx sdk.Context, cdc codec.JSONCodec) json.RawMessage {
	gctx := sdk.WrapSDKContext(ctx)

	next, err := am.keeper.GetNextEpochID(gctx)
	if err != nil {
		panic(err)
	}
	epoch, err := am.keeper.GetEpoch(gctx)
	if err != nil {
		panic(err)
	}
	dkg, err := am.keeper.GetDKG(gctx)
	if err != nil {
		panic(err)
	}

	gs := types.GenesisState{
		NextEpochId: next,
		Epoch:       epoch,
		Dkg:         dkg,
	}
	return cdc.MustMarshalJSON(&gs)
}

func (AppModule) ConsensusVersion() uint64 { return ConsensusVersion }

// ---- App Wiring Setup ----

func init() {
	appmodule.Register(
		&modulev1.Module{},
		appmodule.Provide(ProvideModule),
	)
}

type ModuleInputs struct {
	depinject.In

	Config       *modulev1.Module
	Cdc          codec.Codec
	StoreService corestore.KVStoreService

	StakingKeeper          types.StakingKeeper
	CommitteeStakingKeeper committee.StakingKeeper
	SlashingKeeper         types.SlashingKeeper

	PokerKeeper types.PokerKeeper
}

type ModuleOutputs struct {
	depinject.Out

	DealerKeeper keeper.Keeper
	Module       appmodule.AppModule
}

func ProvideModule(in ModuleInputs) ModuleOutputs {
	k := keeper.NewKeeper(
		in.Cdc,
		in.StoreService,
		in.StakingKeeper,
		in.CommitteeStakingKeeper,
		in.SlashingKeeper,
		in.PokerKeeper,
	)
	m := NewAppModule(in.Cdc, k)
	return ModuleOutputs{DealerKeeper: k, Module: m}
}
