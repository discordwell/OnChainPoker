package types

// Event types are kept close to the legacy v0 names to ease client migration.
const (
	EventTypeTableCreated   = "TableCreated"
	EventTypePlayerSat      = "PlayerSat"
	EventTypeHandStarted    = "HandStarted"
	EventTypeActionApplied  = "ActionApplied"
	EventTypeTimeoutApplied = "TimeoutApplied"
	EventTypePlayerSlashed  = "PlayerSlashed"
	EventTypePlayerLeft     = "PlayerLeft"
	EventTypePlayerEjected  = "PlayerEjected"

	EventTypeStreetRevealed   = "StreetRevealed"
	EventTypeShowdownReached  = "ShowdownReached"
	EventTypePotAwarded       = "PotAwarded"
	EventTypeHandCompleted    = "HandCompleted"
	EventTypeHandAborted      = "HandAborted"
	EventTypeHoleCardRevealed = "HoleCardRevealed"
)

