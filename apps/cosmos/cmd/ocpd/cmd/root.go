package cmd

import (
	"os"

	"github.com/spf13/cobra"

	autocliv1 "cosmossdk.io/api/cosmos/autocli/v1"
	"cosmossdk.io/client/v2/autocli"
	"cosmossdk.io/depinject"
	"cosmossdk.io/log"

	"onchainpoker/apps/cosmos/app"
	appparams "onchainpoker/apps/cosmos/app/params"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
	pokertypes "onchainpoker/apps/cosmos/x/poker/types"

	"github.com/cosmos/cosmos-sdk/client"
	"github.com/cosmos/cosmos-sdk/client/config"
	nodeservice "github.com/cosmos/cosmos-sdk/client/grpc/node"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	"github.com/cosmos/cosmos-sdk/server"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	"github.com/cosmos/cosmos-sdk/version"
	"github.com/cosmos/cosmos-sdk/x/auth/tx"
	authtxconfig "github.com/cosmos/cosmos-sdk/x/auth/tx/config"
	"github.com/cosmos/cosmos-sdk/x/auth/types"
)

func initSDKConfig() {
	cfg := sdk.GetConfig()

	cfg.SetBech32PrefixForAccount(appparams.Bech32Prefix, appparams.Bech32Prefix+"pub")
	cfg.SetBech32PrefixForValidator(appparams.Bech32Prefix+"valoper", appparams.Bech32Prefix+"valoperpub")
	cfg.SetBech32PrefixForConsensusNode(appparams.Bech32Prefix+"valcons", appparams.Bech32Prefix+"valconspub")

	// Genesis defaults depend on this (staking/governance params, etc.).
	sdk.DefaultBondDenom = appparams.BaseDenom

	cfg.Seal()

	version.Name = appparams.AppName
	version.AppName = appparams.BinaryName
}

// NewRootCmd creates a new root command for ocpd. It is called once in main.
func NewRootCmd() *cobra.Command {
	initSDKConfig()

	var (
		autoCliOpts        autocli.AppOptions
		moduleBasicManager module.BasicManager
		clientCtx          client.Context
	)

	if err := depinject.Inject(
		depinject.Configs(
			app.AppConfig,
			depinject.Supply(
				log.NewNopLogger(),
			),
			depinject.Provide(
				ProvideClientContext,
			),
		),
		&autoCliOpts,
		&moduleBasicManager,
		&clientCtx,
	); err != nil {
		panic(err)
	}

	rootCmd := &cobra.Command{
		Use:           appparams.BinaryName,
		Short:         "OnChainPoker Cosmos SDK daemon",
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, _ []string) error {
			// set the default command outputs
			cmd.SetOut(cmd.OutOrStdout())
			cmd.SetErr(cmd.ErrOrStderr())

			clientCtx = clientCtx.WithCmdContext(cmd.Context()).WithViper(appparams.EnvPrefix)
			clientCtx, err := client.ReadPersistentCommandFlags(clientCtx, cmd.Flags())
			if err != nil {
				return err
			}

			clientCtx, err = config.ReadFromClientConfig(clientCtx)
			if err != nil {
				return err
			}

			if err := client.SetCmdClientContextHandler(clientCtx, cmd); err != nil {
				return err
			}

			customAppTemplate, customAppConfig := initAppConfig()
			customCMTConfig := initCometBFTConfig()

			return server.InterceptConfigsPreRunHandler(cmd, customAppTemplate, customAppConfig, customCMTConfig)
		},
	}

	initRootCmd(rootCmd, clientCtx.TxConfig, moduleBasicManager)

	// Add node commands to autocli opts.
	nodeCmds := nodeservice.NewNodeCommands()
	if autoCliOpts.ModuleOptions == nil {
		autoCliOpts.ModuleOptions = make(map[string]*autocliv1.ModuleOptions)
	}
	autoCliOpts.ModuleOptions[nodeCmds.Name()] = nodeCmds.AutoCLIOptions()
	// Enable autocli generation for x/poker.
	autoCliOpts.ModuleOptions[pokertypes.ModuleName] = &autocliv1.ModuleOptions{
		Tx:    &autocliv1.ServiceCommandDescriptor{Service: "onchainpoker.poker.v1.Msg"},
		Query: &autocliv1.ServiceCommandDescriptor{Service: "onchainpoker.poker.v1.Query"},
	}
	// Enable autocli generation for x/dealer.
	autoCliOpts.ModuleOptions[dealertypes.ModuleName] = &autocliv1.ModuleOptions{
		Tx:    &autocliv1.ServiceCommandDescriptor{Service: "onchainpoker.dealer.v1.Msg"},
		Query: &autocliv1.ServiceCommandDescriptor{Service: "onchainpoker.dealer.v1.Query"},
	}

	if err := autoCliOpts.EnhanceRootCommand(rootCmd); err != nil {
		panic(err)
	}

	return rootCmd
}

func ProvideClientContext(
	appCodec codec.Codec,
	interfaceRegistry codectypes.InterfaceRegistry,
	txConfigOpts tx.ConfigOptions,
	legacyAmino *codec.LegacyAmino,
) client.Context {
	clientCtx := client.Context{}.
		WithCodec(appCodec).
		WithInterfaceRegistry(interfaceRegistry).
		WithLegacyAmino(legacyAmino).
		WithInput(os.Stdin).
		WithAccountRetriever(types.AccountRetriever{}).
		WithHomeDir(app.DefaultNodeHome).
		WithViper(appparams.EnvPrefix)

	clientCtx, _ = config.ReadFromClientConfig(clientCtx)

	// Textual is enabled by default; configure the coin metadata query function.
	txConfigOpts.TextualCoinMetadataQueryFn = authtxconfig.NewGRPCCoinMetadataQueryFn(clientCtx)
	txConfig, err := tx.NewTxConfigWithOptions(clientCtx.Codec, txConfigOpts)
	if err != nil {
		panic(err)
	}
	clientCtx = clientCtx.WithTxConfig(txConfig)

	return clientCtx
}
