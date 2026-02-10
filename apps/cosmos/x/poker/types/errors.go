package types

import (
	errorsmod "cosmossdk.io/errors"
	grpccodes "google.golang.org/grpc/codes"
)

// x/poker sentinel errors.
var (
	// Exposed via grpc-gateway; map to HTTP 400 instead of a generic 500.
	ErrInvalidRequest = errorsmod.RegisterWithGRPCCode(ModuleName, 1, grpccodes.InvalidArgument, "invalid request")

	// Queried frequently by clients; map to HTTP 404 instead of a generic 500.
	ErrTableNotFound = errorsmod.RegisterWithGRPCCode(ModuleName, 2, grpccodes.NotFound, "table not found")

	ErrSeatOccupied    = errorsmod.Register(ModuleName, 3, "seat occupied")
	ErrNotSeated       = errorsmod.Register(ModuleName, 4, "not seated at table")
	ErrHandInProgress  = errorsmod.Register(ModuleName, 5, "hand already in progress")
	ErrNoActiveHand    = errorsmod.Register(ModuleName, 6, "no active hand")
	ErrNotYourTurn     = errorsmod.Register(ModuleName, 7, "not your turn")
	ErrInvalidAction   = errorsmod.Register(ModuleName, 8, "invalid action")
	ErrInvalidTableCfg = errorsmod.Register(ModuleName, 9, "invalid table configuration")
)
