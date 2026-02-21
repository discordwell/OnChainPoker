package app

import (
	runtimev1alpha1 "cosmossdk.io/api/cosmos/app/runtime/v1alpha1"
	appv1alpha1 "cosmossdk.io/api/cosmos/app/v1alpha1"
	authmodulev1 "cosmossdk.io/api/cosmos/auth/module/v1"
	bankmodulev1 "cosmossdk.io/api/cosmos/bank/module/v1"
	consensusmodulev1 "cosmossdk.io/api/cosmos/consensus/module/v1"
	distrmodulev1 "cosmossdk.io/api/cosmos/distribution/module/v1"
	evidencemodulev1 "cosmossdk.io/api/cosmos/evidence/module/v1"
	genutilmodulev1 "cosmossdk.io/api/cosmos/genutil/module/v1"
	slashingmodulev1 "cosmossdk.io/api/cosmos/slashing/module/v1"
	stakingmodulev1 "cosmossdk.io/api/cosmos/staking/module/v1"
	txconfigv1 "cosmossdk.io/api/cosmos/tx/config/v1"
	vestingmodulev1 "cosmossdk.io/api/cosmos/vesting/module/v1"
	"cosmossdk.io/core/appconfig"
	"cosmossdk.io/depinject"

	"onchainpoker/apps/cosmos/app/params"
	dealermodulev1 "onchainpoker/apps/cosmos/x/dealer/module/v1"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
	pokermodulev1 "onchainpoker/apps/cosmos/x/poker/module/v1"
	pokertypes "onchainpoker/apps/cosmos/x/poker/types"

	ibcexported "github.com/cosmos/ibc-go/v10/modules/core/exported"
	ibctransfertypes "github.com/cosmos/ibc-go/v10/modules/apps/transfer/types"

	"github.com/cosmos/cosmos-sdk/runtime"
	"github.com/cosmos/cosmos-sdk/types/module"
	_ "github.com/cosmos/cosmos-sdk/x/auth"           // import for side-effects
	_ "github.com/cosmos/cosmos-sdk/x/auth/tx/config" // import for side-effects
	authtypes "github.com/cosmos/cosmos-sdk/x/auth/types"
	_ "github.com/cosmos/cosmos-sdk/x/auth/vesting" // import for side-effects
	vestingtypes "github.com/cosmos/cosmos-sdk/x/auth/vesting/types"
	_ "github.com/cosmos/cosmos-sdk/x/bank" // import for side-effects
	banktypes "github.com/cosmos/cosmos-sdk/x/bank/types"
	_ "github.com/cosmos/cosmos-sdk/x/consensus" // import for side-effects
	consensustypes "github.com/cosmos/cosmos-sdk/x/consensus/types"
	_ "github.com/cosmos/cosmos-sdk/x/distribution" // import for side-effects
	distrtypes "github.com/cosmos/cosmos-sdk/x/distribution/types"
	_ "github.com/cosmos/cosmos-sdk/x/evidence" // import for side-effects
	evidencetypes "github.com/cosmos/cosmos-sdk/x/evidence/types"
	"github.com/cosmos/cosmos-sdk/x/genutil"
	genutiltypes "github.com/cosmos/cosmos-sdk/x/genutil/types"
	_ "github.com/cosmos/cosmos-sdk/x/slashing" // import for side-effects
	slashingtypes "github.com/cosmos/cosmos-sdk/x/slashing/types"
	_ "github.com/cosmos/cosmos-sdk/x/staking" // import for side-effects
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"

	_ "onchainpoker/apps/cosmos/x/dealer" // import for side-effects
	_ "onchainpoker/apps/cosmos/x/poker"  // import for side-effects
)

var (
	// moduleAccPerms defines the module account permissions for the app.
	moduleAccPerms = []*authmodulev1.ModuleAccountPermission{
		{Account: authtypes.FeeCollectorName},
		{Account: distrtypes.ModuleName},
		{Account: stakingtypes.BondedPoolName, Permissions: []string{authtypes.Burner, stakingtypes.ModuleName}},
		{Account: stakingtypes.NotBondedPoolName, Permissions: []string{authtypes.Burner, stakingtypes.ModuleName}},
		// Game escrow module account (holds table buy-ins/bonds).
		{Account: pokertypes.ModuleName},
		// ICS-20 transfer module needs Minter + Burner for cross-chain tokens.
		{Account: ibctransfertypes.ModuleName, Permissions: []string{authtypes.Minter, authtypes.Burner}},
	}

	// blockedModuleAccounts is the list of module account names that cannot
	// receive external funds via the bank module.
	blockedModuleAccounts = []string{
		authtypes.FeeCollectorName,
		distrtypes.ModuleName,
		stakingtypes.BondedPoolName,
		stakingtypes.NotBondedPoolName,
		pokertypes.ModuleName,
	}

	ModuleConfig = []*appv1alpha1.ModuleConfig{
		{
			Name: runtime.ModuleName,
			Config: appconfig.WrapAny(&runtimev1alpha1.Module{
				AppName: params.AppName,
				PreBlockers: []string{
					authtypes.ModuleName,
				},
				// During begin block slashing happens after distr.BeginBlocker so that
				// there is nothing left over in the validator fee pool, so as to keep the
				// CanWithdrawInvariant invariant.
				BeginBlockers: []string{
					distrtypes.ModuleName,
					slashingtypes.ModuleName,
					evidencetypes.ModuleName,
					stakingtypes.ModuleName,
					ibcexported.ModuleName,
					ibctransfertypes.ModuleName,
				},
				EndBlockers: []string{
					banktypes.ModuleName,
					stakingtypes.ModuleName,
					ibcexported.ModuleName,
					ibctransfertypes.ModuleName,
				},
				SkipStoreKeys: []string{
					"tx",
				},
				// NOTE: The genutils module must occur after staking so that pools are
				// properly initialized with tokens from genesis accounts.
				// NOTE: The genutils module must also occur after auth so that it can access the params from auth.
				InitGenesis: []string{
					authtypes.ModuleName,
					banktypes.ModuleName,
					pokertypes.ModuleName,
					distrtypes.ModuleName,
					stakingtypes.ModuleName,
					slashingtypes.ModuleName,
					ibcexported.ModuleName,
					ibctransfertypes.ModuleName,
					dealertypes.ModuleName,
					genutiltypes.ModuleName,
					evidencetypes.ModuleName,
					vestingtypes.ModuleName,
				},
				ExportGenesis: []string{
					consensustypes.ModuleName,
					authtypes.ModuleName,
					banktypes.ModuleName,
					pokertypes.ModuleName,
					distrtypes.ModuleName,
					stakingtypes.ModuleName,
					slashingtypes.ModuleName,
					ibcexported.ModuleName,
					ibctransfertypes.ModuleName,
					dealertypes.ModuleName,
					genutiltypes.ModuleName,
					evidencetypes.ModuleName,
					vestingtypes.ModuleName,
				},
			}),
		},
		{
			Name: authtypes.ModuleName,
			Config: appconfig.WrapAny(&authmodulev1.Module{
				Bech32Prefix:                params.Bech32Prefix,
				ModuleAccountPermissions:    moduleAccPerms,
				EnableUnorderedTransactions: true,
			}),
		},
		{
			Name:   vestingtypes.ModuleName,
			Config: appconfig.WrapAny(&vestingmodulev1.Module{}),
		},
		{
			Name: banktypes.ModuleName,
			Config: appconfig.WrapAny(&bankmodulev1.Module{
				BlockedModuleAccountsOverride: blockedModuleAccounts,
			}),
		},
		{
			Name:   pokertypes.ModuleName,
			Config: appconfig.WrapAny(&pokermodulev1.Module{}),
		},
		{
			Name:   dealertypes.ModuleName,
			Config: appconfig.WrapAny(&dealermodulev1.Module{}),
		},
		{
			Name: stakingtypes.ModuleName,
			Config: appconfig.WrapAny(&stakingmodulev1.Module{
				Bech32PrefixValidator: params.Bech32Prefix + "valoper",
				Bech32PrefixConsensus: params.Bech32Prefix + "valcons",
			}),
		},
		{
			Name:   slashingtypes.ModuleName,
			Config: appconfig.WrapAny(&slashingmodulev1.Module{}),
		},
		{
			Name: "tx",
			Config: appconfig.WrapAny(&txconfigv1.Config{
				SkipAnteHandler: false,
			}),
		},
		{
			Name:   genutiltypes.ModuleName,
			Config: appconfig.WrapAny(&genutilmodulev1.Module{}),
		},
		{
			Name:   distrtypes.ModuleName,
			Config: appconfig.WrapAny(&distrmodulev1.Module{}),
		},
		{
			Name:   evidencetypes.ModuleName,
			Config: appconfig.WrapAny(&evidencemodulev1.Module{}),
		},
		{
			Name:   consensustypes.ModuleName,
			Config: appconfig.WrapAny(&consensusmodulev1.Module{}),
		},
	}

	// AppConfig is application configuration (used by depinject).
	AppConfig = depinject.Configs(
		appconfig.Compose(&appv1alpha1.Config{
			Modules: ModuleConfig,
		}),
		depinject.Supply(
			// Custom module basics
			map[string]module.AppModuleBasic{
				genutiltypes.ModuleName: genutil.NewAppModuleBasic(genutiltypes.DefaultMessageValidator),
			},
		),
	)
)
