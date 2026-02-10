package main

import (
	"fmt"
	"os"

	"onchainpoker/apps/cosmos/app"
	appparams "onchainpoker/apps/cosmos/app/params"
	"onchainpoker/apps/cosmos/cmd/ocpd/cmd"

	svrcmd "github.com/cosmos/cosmos-sdk/server/cmd"
)

func main() {
	rootCmd := cmd.NewRootCmd()
	if err := svrcmd.Execute(rootCmd, appparams.EnvPrefix, app.DefaultNodeHome); err != nil {
		fmt.Fprintln(rootCmd.OutOrStderr(), err)
		os.Exit(1)
	}
}
