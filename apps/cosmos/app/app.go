package app

import (
	"io"

	dbm "github.com/cosmos/cosmos-db"

	clienthelpers "cosmossdk.io/client/v2/helpers"
	"cosmossdk.io/depinject"
	"cosmossdk.io/log"
	"cosmossdk.io/store/rootmulti"
	storetypes "cosmossdk.io/store/types"

	appparams "onchainpoker/apps/cosmos/app/params"
	pokerkeeper "onchainpoker/apps/cosmos/x/poker/keeper"

	"github.com/cosmos/cosmos-sdk/baseapp"
	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/server"
	"github.com/cosmos/cosmos-sdk/server/api"
	"github.com/cosmos/cosmos-sdk/server/config"
	servertypes "github.com/cosmos/cosmos-sdk/server/types"
	"github.com/cosmos/cosmos-sdk/x/auth/ante"
	authkeeper "github.com/cosmos/cosmos-sdk/x/auth/keeper"
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	bankkeeper "github.com/cosmos/cosmos-sdk/x/bank/keeper"
	consensuskeeper "github.com/cosmos/cosmos-sdk/x/consensus/keeper"
	distrkeeper "github.com/cosmos/cosmos-sdk/x/distribution/keeper"
	evidencekeeper "github.com/cosmos/cosmos-sdk/x/evidence/keeper"
	slashingkeeper "github.com/cosmos/cosmos-sdk/x/slashing/keeper"
	stakingkeeper "github.com/cosmos/cosmos-sdk/x/staking/keeper"

	// IBC
	"github.com/cosmos/ibc-go/v10/modules/apps/transfer"
	ibctransferkeeper "github.com/cosmos/ibc-go/v10/modules/apps/transfer/keeper"
	ibctransfertypes "github.com/cosmos/ibc-go/v10/modules/apps/transfer/types"
	transferv2 "github.com/cosmos/ibc-go/v10/modules/apps/transfer/v2"
	ibc "github.com/cosmos/ibc-go/v10/modules/core"
	porttypes "github.com/cosmos/ibc-go/v10/modules/core/05-port/types"
	ibcapi "github.com/cosmos/ibc-go/v10/modules/core/api"
	ibcexported "github.com/cosmos/ibc-go/v10/modules/core/exported"
	ibckeeper "github.com/cosmos/ibc-go/v10/modules/core/keeper"
	solomachine "github.com/cosmos/ibc-go/v10/modules/light-clients/06-solomachine"
	ibctm "github.com/cosmos/ibc-go/v10/modules/light-clients/07-tendermint"
)

// DefaultNodeHome is the default node home directory for `ocpd`.
var DefaultNodeHome string

var (
	_ runtime.AppI            = (*OcpApp)(nil)
	_ servertypes.Application = (*OcpApp)(nil)
)

// OcpApp is the Cosmos SDK application for OnChainPoker.
type OcpApp struct {
	*runtime.App

	legacyAmino       *codec.LegacyAmino
	appCodec          codec.Codec
	txConfig          client.TxConfig
	interfaceRegistry codectypes.InterfaceRegistry

	// Exposed keepers for downstream modules/tests.
	AccountKeeper         authkeeper.AccountKeeper
	BankKeeper            bankkeeper.BaseKeeper
	PokerKeeper           pokerkeeper.Keeper
	StakingKeeper         *stakingkeeper.Keeper
	SlashingKeeper        slashingkeeper.Keeper
	DistrKeeper           distrkeeper.Keeper
	EvidenceKeeper        evidencekeeper.Keeper
	ConsensusParamsKeeper consensuskeeper.Keeper

	// IBC keepers (manually wired — ibc-go v10 does not support depinject).
	IBCKeeper      *ibckeeper.Keeper
	TransferKeeper *ibctransferkeeper.Keeper
}

func init() {
	var err error
	// Align default home dir detection with CLI env vars (e.g. OCPD_HOME).
	clienthelpers.EnvPrefix = appparams.EnvPrefix
	DefaultNodeHome, err = clienthelpers.GetNodeHomeDirectory(".ocpd")
	if err != nil {
		panic(err)
	}
}

func NewOcpApp(
	logger log.Logger,
	db dbm.DB,
	traceStore io.Writer,
	loadLatest bool,
	appOpts servertypes.AppOptions,
	baseAppOptions ...func(*baseapp.BaseApp),
) *OcpApp {
	var (
		app        = &OcpApp{}
		appBuilder *runtime.AppBuilder

		appConfig = depinject.Configs(
			AppConfig,
			depinject.Supply(
				appOpts,
				logger,
			),
		)
	)

	if err := depinject.Inject(
		appConfig,
		&appBuilder,
		&app.appCodec,
		&app.legacyAmino,
		&app.txConfig,
		&app.interfaceRegistry,
		&app.AccountKeeper,
		&app.BankKeeper,
		&app.PokerKeeper,
		&app.StakingKeeper,
		&app.SlashingKeeper,
		&app.DistrKeeper,
		&app.EvidenceKeeper,
		&app.ConsensusParamsKeeper,
	); err != nil {
		panic(err)
	}

	app.App = appBuilder.Build(db, traceStore, baseAppOptions...)

	// ── IBC: register stores, keepers, router, light clients, modules ──

	ibcStoreKey := storetypes.NewKVStoreKey(ibcexported.StoreKey)
	transferStoreKey := storetypes.NewKVStoreKey(ibctransfertypes.StoreKey)
	if err := app.RegisterStores(ibcStoreKey, transferStoreKey); err != nil {
		panic(err)
	}

	// IBC authority — set to the IBC module address so nobody can submit
	// governance-style IBC messages (chain has no x/gov).
	ibcAuthority := authtypes.NewModuleAddress(ibcexported.ModuleName).String()

	app.IBCKeeper = ibckeeper.NewKeeper(
		app.appCodec,
		runtime.NewKVStoreService(ibcStoreKey),
		noopUpgradeKeeper{sentinel: 1},
		ibcAuthority,
	)

	app.TransferKeeper = ibctransferkeeper.NewKeeper(
		app.appCodec,
		app.AccountKeeper.AddressCodec(),
		runtime.NewKVStoreService(transferStoreKey),
		app.IBCKeeper.ChannelKeeper,
		app.MsgServiceRouter(),
		app.AccountKeeper,
		app.BankKeeper,
		ibcAuthority,
	)

	// IBC v1 router (classic IBC modules).
	// Wire the transfer module directly (no middleware needed yet).
	// SetICS4Wrapper points outbound packets at the channel keeper.
	ibcRouter := porttypes.NewRouter()
	transferApp := transfer.NewIBCModule(app.TransferKeeper)
	transferApp.SetICS4Wrapper(app.IBCKeeper.ChannelKeeper)
	ibcRouter.AddRoute(ibctransfertypes.ModuleName, transferApp)
	app.IBCKeeper.SetRouter(ibcRouter)

	// IBC v2 router.
	ibcRouterV2 := ibcapi.NewRouter()
	ibcRouterV2.AddRoute(ibctransfertypes.PortID, transferv2.NewIBCModule(app.TransferKeeper))
	app.IBCKeeper.SetRouterV2(ibcRouterV2)

	// Light clients.
	storeProvider := app.IBCKeeper.ClientKeeper.GetStoreProvider()

	tmLightClient := ibctm.NewLightClientModule(app.appCodec, storeProvider)
	app.IBCKeeper.ClientKeeper.AddRoute(ibctm.ModuleName, &tmLightClient)

	smLightClient := solomachine.NewLightClientModule(app.appCodec, storeProvider)
	app.IBCKeeper.ClientKeeper.AddRoute(solomachine.ModuleName, &smLightClient)

	// Register IBC modules with the runtime (not managed by depinject).
	if err := app.RegisterModules(
		ibc.NewAppModule(app.IBCKeeper),
		transfer.NewAppModule(app.TransferKeeper),
		ibctm.NewAppModule(tmLightClient),
		solomachine.NewAppModule(smLightClient),
	); err != nil {
		panic(err)
	}

	// ── end IBC ──

	// Custom ante handler (includes IBC RedundantRelayDecorator).
	anteHandler, err := NewAnteHandler(AnteHandlerOptions{
		HandlerOptions: ante.HandlerOptions{
			AccountKeeper:   app.AccountKeeper,
			BankKeeper:      app.BankKeeper,
			SignModeHandler: app.txConfig.SignModeHandler(),
			SigGasConsumer:  ante.DefaultSigVerificationGasConsumer,
		},
		IBCKeeper: app.IBCKeeper,
	})
	if err != nil {
		panic(err)
	}
	app.SetAnteHandler(anteHandler)

	// Register streaming services (if enabled via app.toml).
	if err := app.RegisterStreamingServices(appOpts, app.kvStoreKeys()); err != nil {
		panic(err)
	}

	app.RegisterUpgradeHandlers()

	if err := app.Load(loadLatest); err != nil {
		panic(err)
	}

	// Workaround for GoLevelDB treating empty []byte{} values as non-existent.
	// IAVL's SaveEmptyRoot writes []byte{} for stores with no data, which breaks
	// CacheMultiStoreWithVersion (used by gRPC/REST queries) for those stores.
	// See querywrap.go for details.
	if rms, ok := app.CommitMultiStore().(*rootmulti.Store); ok {
		app.SetQueryMultiStore(&queryMultiStore{Store: rms})
	}

	return app
}

// RegisterUpgradeHandlers wires on-chain upgrade handlers (placeholder for now).
func (app *OcpApp) RegisterUpgradeHandlers() {}

func (app *OcpApp) LegacyAmino() *codec.LegacyAmino { return app.legacyAmino }
func (app *OcpApp) AppCodec() codec.Codec           { return app.appCodec }
func (app *OcpApp) InterfaceRegistry() codectypes.InterfaceRegistry {
	return app.interfaceRegistry
}
func (app *OcpApp) TxConfig() client.TxConfig { return app.txConfig }

func (app *OcpApp) kvStoreKeys() map[string]*storetypes.KVStoreKey {
	keys := make(map[string]*storetypes.KVStoreKey)
	for _, k := range app.GetStoreKeys() {
		if kv, ok := k.(*storetypes.KVStoreKey); ok {
			keys[kv.Name()] = kv
		}
	}
	return keys
}

// RegisterAPIRoutes registers all application module routes with the provided API server.
func (app *OcpApp) RegisterAPIRoutes(apiSvr *api.Server, apiConfig config.APIConfig) {
	app.App.RegisterAPIRoutes(apiSvr, apiConfig)
	if err := server.RegisterSwaggerAPI(apiSvr.ClientCtx, apiSvr.Router, apiConfig.Swagger); err != nil {
		panic(err)
	}
}
