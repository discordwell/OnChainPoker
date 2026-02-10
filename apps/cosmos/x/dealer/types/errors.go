package types

import errorsmod "cosmossdk.io/errors"

// x/dealer sentinel errors.
var (
	ErrInvalidRequest = errorsmod.Register(ModuleName, 1, "invalid request")
	ErrNoActiveEpoch  = errorsmod.Register(ModuleName, 2, "no active dealer epoch")
	ErrNoDkgInFlight  = errorsmod.Register(ModuleName, 3, "no dkg in progress")
	ErrHandNotFound   = errorsmod.Register(ModuleName, 4, "dealer hand not found")
)
