package types

import (
	errorsmod "cosmossdk.io/errors"
	grpccodes "google.golang.org/grpc/codes"
)

// x/dealer sentinel errors.
var (
	// Exposed via grpc-gateway; map to HTTP 400 instead of a generic 500.
	ErrInvalidRequest = errorsmod.RegisterWithGRPCCode(ModuleName, 1, grpccodes.InvalidArgument, "invalid request")

	ErrNoActiveEpoch = errorsmod.RegisterWithGRPCCode(ModuleName, 2, grpccodes.FailedPrecondition, "no active dealer epoch")
	ErrNoDkgInFlight = errorsmod.RegisterWithGRPCCode(ModuleName, 3, grpccodes.FailedPrecondition, "no dkg in progress")

	// Queried by clients; map to HTTP 404 instead of a generic 500.
	ErrHandNotFound = errorsmod.RegisterWithGRPCCode(ModuleName, 4, grpccodes.NotFound, "dealer hand not found")

	ErrUnauthorized = errorsmod.RegisterWithGRPCCode(ModuleName, 5, grpccodes.PermissionDenied, "unauthorized")
)
