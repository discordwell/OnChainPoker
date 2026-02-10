package codec

import (
	"encoding/json"
	"fmt"
)

// TxEnvelope is the v0 transaction container.
//
// CometBFT transactions are opaque bytes. For v0 localnet we use JSON-encoded
// txs to move fast; this is NOT the final protocol encoding.
type TxEnvelope struct {
	// Basic routing.
	Type  string          `json:"type"`
	Value json.RawMessage `json:"value"`

	// v0 tx auth (optional):
	// - Nonce: included in the signed message for replay protection (must increase per signer).
	// - Signer: logical signer id (validatorId for validator-signed txs).
	// - Sig: Ed25519 signature over (type, nonce, signer, sha256(value)).
	//
	// Note: This is still a scaffold; it is NOT the final protocol encoding.
	Nonce  string `json:"nonce,omitempty"`
	Signer string `json:"signer,omitempty"`
	Sig    []byte `json:"sig,omitempty"`
}

func DecodeTxEnvelope(txBytes []byte) (TxEnvelope, error) {
	var env TxEnvelope
	if err := json.Unmarshal(txBytes, &env); err != nil {
		return TxEnvelope{}, fmt.Errorf("invalid tx json: %w", err)
	}
	if env.Type == "" {
		return TxEnvelope{}, fmt.Errorf("missing tx.type")
	}
	return env, nil
}

// ---- Bank ----

type BankMintTx struct {
	To     string `json:"to"`
	Amount uint64 `json:"amount"`
}

type BankSendTx struct {
	From   string `json:"from"`
	To     string `json:"to"`
	Amount uint64 `json:"amount"`
}

// ---- Auth (v0) ----

// v0: account pubkey registration for tx authentication.
type AuthRegisterAccountTx struct {
	Account string `json:"account"`
	PubKey  []byte `json:"pubKey"` // base64 (32 bytes)
}

// ---- Poker ----

type PokerCreateTableTx struct {
	Creator    string `json:"creator"`
	SmallBlind uint64 `json:"smallBlind"`
	BigBlind   uint64 `json:"bigBlind"`
	MinBuyIn   uint64 `json:"minBuyIn"`
	MaxBuyIn   uint64 `json:"maxBuyIn"`
	ActionTO   uint64 `json:"actionTimeoutSecs,omitempty"`
	DealerTO   uint64 `json:"dealerTimeoutSecs,omitempty"`
	PlayerBond uint64 `json:"playerBond,omitempty"`
	RakeBps    uint32 `json:"rakeBps,omitempty"`
	MaxPlayers uint8  `json:"maxPlayers,omitempty"` // default 9
	TableLabel string `json:"label,omitempty"`
}

type PokerSitTx struct {
	Player   string `json:"player"`
	TableID  uint64 `json:"tableId"`
	Seat     uint8  `json:"seat"`
	BuyIn    uint64 `json:"buyIn"`
	PKPlayer string `json:"pkPlayer,omitempty"` // accepted but unused in DealerStub
}

type PokerStartHandTx struct {
	Caller  string `json:"caller"`
	TableID uint64 `json:"tableId"`
}

type PokerActTx struct {
	Player  string `json:"player"`
	TableID uint64 `json:"tableId"`
	Action  string `json:"action"`           // fold|check|call|bet|raise
	Amount  uint64 `json:"amount,omitempty"` // for bet/raise only: desired total street commitment ("BetTo")
}

type PokerTickTx struct {
	TableID uint64 `json:"tableId"`
}

type PokerLeaveTx struct {
	Player  string `json:"player"`
	TableID uint64 `json:"tableId"`
}

// ---- Staking (v0) ----

// v0: staking is a stubbed on-chain validator registry (no real consensus auth yet).
type StakingRegisterValidatorTx struct {
	ValidatorID string `json:"validatorId"`
	PubKey      []byte `json:"pubKey"` // base64 (32 bytes)
	Power       uint64 `json:"power,omitempty"`
}

type StakingBondTx struct {
	ValidatorID string `json:"validatorId"`
	Amount      uint64 `json:"amount"`
}

type StakingUnbondTx struct {
	ValidatorID string `json:"validatorId"`
	Amount      uint64 `json:"amount"`
}

type StakingUnjailTx struct {
	ValidatorID string `json:"validatorId"`
}

// ---- Dealer (v0) ----

type DealerBeginEpochTx struct {
	// If epochId is 0, the chain allocates the next epoch id deterministically.
	EpochID uint64 `json:"epochId,omitempty"`

	CommitteeSize uint32 `json:"committeeSize"`
	Threshold     uint8  `json:"threshold"`

	// Optional randomness beacon input used for deterministic committee sampling (opaque in v0).
	RandEpoch []byte `json:"randEpoch,omitempty"` // base64 in JSON

	// Optional DKG phase durations in blocks (v0 localnet). Defaults are used when omitted/zero.
	CommitBlocks    uint64 `json:"commitBlocks,omitempty"`
	ComplaintBlocks uint64 `json:"complaintBlocks,omitempty"`
	RevealBlocks    uint64 `json:"revealBlocks,omitempty"`
	FinalizeBlocks  uint64 `json:"finalizeBlocks,omitempty"`
}

type DealerDKGCommitTx struct {
	EpochID     uint64   `json:"epochId"`
	DealerID    string   `json:"dealerId"`
	Commitments [][]byte `json:"commitments"` // base64 points (32 bytes each)
}

type DealerDKGComplaintMissingTx struct {
	EpochID      uint64 `json:"epochId"`
	ComplainerID string `json:"complainerId"`
	DealerID     string `json:"dealerId"`
}

type DealerDKGComplaintInvalidTx struct {
	EpochID      uint64 `json:"epochId"`
	ComplainerID string `json:"complainerId"`
	DealerID     string `json:"dealerId"`
	ShareMsg     []byte `json:"shareMsg"` // opaque (v0)
}

type DealerDKGShareRevealTx struct {
	EpochID  uint64 `json:"epochId"`
	DealerID string `json:"dealerId"`
	ToID     string `json:"toId"`
	Share    []byte `json:"share"` // base64 scalar (32 bytes)
}

type DealerFinalizeEpochTx struct {
	EpochID uint64 `json:"epochId"`
}

type DealerDKGTimeoutTx struct {
	EpochID uint64 `json:"epochId"`
}

type DealerInitHandTx struct {
	TableID  uint64 `json:"tableId"`
	HandID   uint64 `json:"handId"`
	EpochID  uint64 `json:"epochId"`
	DeckSize uint16 `json:"deckSize,omitempty"` // default 52
}

type DealerSubmitShuffleTx struct {
	TableID    uint64 `json:"tableId"`
	HandID     uint64 `json:"handId"`
	Round      uint16 `json:"round"`
	ShufflerID string `json:"shufflerId"`
	ProofBytes []byte `json:"proofShuffle"` // base64 in JSON
}

type DealerFinalizeDeckTx struct {
	TableID uint64 `json:"tableId"`
	HandID  uint64 `json:"handId"`
}

type DealerSubmitPubShareTx struct {
	TableID     uint64 `json:"tableId"`
	HandID      uint64 `json:"handId"`
	Pos         uint8  `json:"pos"`
	ValidatorID string `json:"validatorId"`
	Share       []byte `json:"pubShare"`   // base64 in JSON
	Proof       []byte `json:"proofShare"` // base64 in JSON
}

type DealerSubmitEncShareTx struct {
	TableID     uint64 `json:"tableId"`
	HandID      uint64 `json:"handId"`
	Pos         uint8  `json:"pos"`
	ValidatorID string `json:"validatorId"`
	PKPlayer    []byte `json:"pkPlayer"`      // base64 in JSON
	EncShare    []byte `json:"encShare"`      // base64 in JSON (64 bytes u||v)
	Proof       []byte `json:"proofEncShare"` // base64 in JSON
}

type DealerFinalizeRevealTx struct {
	TableID uint64 `json:"tableId"`
	HandID  uint64 `json:"handId"`
	Pos     uint8  `json:"pos"`
}

type DealerTimeoutTx struct {
	TableID uint64 `json:"tableId"`
	HandID  uint64 `json:"handId"`
}
