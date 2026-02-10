package types

// Event types are kept close to the legacy v0 names to ease client migration.
const (
	EventTypeDealerEpochBegun   = "DealerEpochBegun"
	EventTypeDealerEpochFinal   = "DealerEpochFinalized"
	EventTypeDealerEpochAborted = "DealerEpochAborted"

	EventTypeDKGCommitAccepted     = "DKGCommitAccepted"
	EventTypeDKGComplaintAccepted  = "DKGComplaintAccepted"
	EventTypeDKGShareRevealed      = "DKGShareRevealed"
	EventTypeDKGTimeoutApplied     = "DKGTimeoutApplied"
	EventTypeDealerHandInitialized = "DealerHandInitialized"

	EventTypeShuffleAccepted   = "ShuffleAccepted"
	EventTypeDeckFinalized     = "DeckFinalized"
	EventTypePubShareAccepted  = "PubShareAccepted"
	EventTypeEncShareAccepted  = "EncShareAccepted"
	EventTypeHoleCardsReady    = "HoleCardsReady"
	EventTypeRevealFinalized   = "RevealFinalized"
	EventTypeDealerTimeoutDone = "DealerTimeoutApplied"

	// ValidatorSlashed is also emitted by other modules; keep the legacy name for tooling.
	EventTypeValidatorSlashed = "ValidatorSlashed"
)
