package app

import (
	"io"

	dbm "github.com/cosmos/cosmos-db"

	clienthelpers "cosmossdk.io/client/v2/helpers"
	"cosmossdk.io/depinject"
	"cosmossdk.io/log"
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
	authkeeper "github.com/cosmos/cosmos-sdk/x/auth/keeper"
	bankkeeper "github.com/cosmos/cosmos-sdk/x/bank/keeper"
	consensuskeeper "github.com/cosmos/cosmos-sdk/x/consensus/keeper"
	distrkeeper "github.com/cosmos/cosmos-sdk/x/distribution/keeper"
	evidencekeeper "github.com/cosmos/cosmos-sdk/x/evidence/keeper"
	govkeeper "github.com/cosmos/cosmos-sdk/x/gov/keeper"
	slashingkeeper "github.com/cosmos/cosmos-sdk/x/slashing/keeper"
	stakingkeeper "github.com/cosmos/cosmos-sdk/x/staking/keeper"
	upgradekeeper "github.com/cosmos/cosmos-sdk/x/upgrade/keeper"
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
	GovKeeper             *govkeeper.Keeper
	UpgradeKeeper         *upgradekeeper.Keeper
	EvidenceKeeper        evidencekeeper.Keeper
	ConsensusParamsKeeper consensuskeeper.Keeper
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
		&app.GovKeeper,
		&app.UpgradeKeeper,
		&app.EvidenceKeeper,
		&app.ConsensusParamsKeeper,
	); err != nil {
		panic(err)
	}

	app.App = appBuilder.Build(db, traceStore, baseAppOptions...)

	// Register streaming services (if enabled via app.toml).
	if err := app.RegisterStreamingServices(appOpts, app.kvStoreKeys()); err != nil {
		panic(err)
	}

	app.RegisterUpgradeHandlers()

	if err := app.Load(loadLatest); err != nil {
		panic(err)
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
