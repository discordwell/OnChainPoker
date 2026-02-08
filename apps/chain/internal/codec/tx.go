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
	Amount  uint64 `json:"amount,omitempty"` // for bet/raise only (delta chips in v0)
}
