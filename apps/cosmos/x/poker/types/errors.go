package types

import errorsmod "cosmossdk.io/errors"

// x/poker sentinel errors.
var (
	ErrInvalidRequest  = errorsmod.Register(ModuleName, 1, "invalid request")
	ErrTableNotFound   = errorsmod.Register(ModuleName, 2, "table not found")
	ErrSeatOccupied    = errorsmod.Register(ModuleName, 3, "seat occupied")
	ErrNotSeated       = errorsmod.Register(ModuleName, 4, "not seated at table")
	ErrHandInProgress  = errorsmod.Register(ModuleName, 5, "hand already in progress")
	ErrNoActiveHand    = errorsmod.Register(ModuleName, 6, "no active hand")
	ErrNotYourTurn     = errorsmod.Register(ModuleName, 7, "not your turn")
	ErrInvalidAction   = errorsmod.Register(ModuleName, 8, "invalid action")
	ErrInvalidTableCfg = errorsmod.Register(ModuleName, 9, "invalid table configuration")
)

