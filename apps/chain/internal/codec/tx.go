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
	Type  string          `json:"type"`
	Value json.RawMessage `json:"value"`
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

// ---- Dealer (v0) ----

type DealerMember struct {
	ValidatorID string `json:"validatorId"`
	Index       uint32 `json:"index"`
	PubShare    []byte `json:"pubShare"` // base64 in JSON
}

type DealerBeginEpochTx struct {
	EpochID   uint64        `json:"epochId"`
	Threshold uint8         `json:"threshold"`
	PKEpoch   []byte        `json:"pkEpoch"` // base64 in JSON
	Members   []DealerMember `json:"members"`
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
