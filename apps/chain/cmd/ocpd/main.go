package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/cometbft/cometbft/abci/server"

	"onchainpoker/apps/chain/internal/app"
)

func main() {
	var (
		home      = flag.String("home", ".ocp", "app home directory (state will be stored under <home>/app)")
		addr      = flag.String("addr", "tcp://127.0.0.1:26658", "ABCI listen address")
		transport = flag.String("transport", "socket", "ABCI transport (socket|grpc)")
	)
	flag.Parse()

	a, err := app.New(*home)
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "init app: %v\n", err)
		os.Exit(1)
	}

	srv, err := server.NewServer(*addr, *transport, a)
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "start abci server: %v\n", err)
		os.Exit(1)
	}

	if err := srv.Start(); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "abci server start: %v\n", err)
		os.Exit(1)
	}
	defer func() { _ = srv.Stop() }()

	// Wait for signal.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
}
