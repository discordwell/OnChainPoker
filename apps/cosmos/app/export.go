package app

import (
	"encoding/json"

	cmtproto "github.com/cometbft/cometbft/api/cometbft/types/v2"

	servertypes "github.com/cosmos/cosmos-sdk/server/types"
	"github.com/cosmos/cosmos-sdk/types/module"
	"github.com/cosmos/cosmos-sdk/x/staking"
)

// ExportAppStateAndValidators exports the app state and bonded validator set for genesis export.
//
// NOTE: forZeroHeight currently performs a best-effort export without additional state normalization.
func (app *OcpApp) ExportAppStateAndValidators(
	forZeroHeight bool,
	jailAllowedAddrs, modulesToExport []string,
) (servertypes.ExportedApp, error) {
	_ = jailAllowedAddrs

	ctx := app.NewContextLegacy(true, cmtproto.Header{Height: app.LastBlockHeight()})

	// Export at last height + 1, which is the height CometBFT will start InitChain at.
	height := app.LastBlockHeight() + 1
	if forZeroHeight {
		height = 0
	}

	genState, err := app.ModuleManager.ExportGenesisForModules(ctx, app.appCodec, modulesToExport)
	if err != nil {
		return servertypes.ExportedApp{}, err
	}

	appState, err := json.MarshalIndent(genState, "", "  ")
	if err != nil {
		return servertypes.ExportedApp{}, err
	}

	validators, err := staking.WriteValidators(ctx, app.StakingKeeper)
	return servertypes.ExportedApp{
		AppState:        appState,
		Validators:      validators,
		Height:          height,
		ConsensusParams: app.GetConsensusParams(ctx),
	}, err
}

// SimulationManager implements runtime.AppI. We don't currently run the SDK simulator.
func (app *OcpApp) SimulationManager() *module.SimulationManager { return nil }
