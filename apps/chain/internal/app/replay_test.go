package app

import (
	"crypto/ed25519"
	"strings"
	"testing"

	"onchainpoker/apps/chain/internal/codec"
)

func TestReplayProtection_AccountSigned(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	mintTestTokens(t, a, height, "alice", 100)
	mintTestTokens(t, a, height, "bob", 100)
	registerTestAccount(t, a, height, "alice")

	tx := txBytesSigned(t, "bank/send", map[string]any{"from": "alice", "to": "bob", "amount": 1}, "alice")
	mustOk(t, a.deliverTx(tx, height, 0))

	res := a.deliverTx(tx, height, 0)
	if res.Code == 0 {
		t.Fatalf("expected replay to be rejected")
	}
	if !strings.Contains(res.Log, "replayed tx.nonce") {
		t.Fatalf("expected replay log to mention nonce, got %q", res.Log)
	}
}

func TestReplayProtection_ValidatorSigned(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	mintTestTokens(t, a, height, "v1", 100)

	pub, _ := testEd25519Key("v1")
	mustOk(t, a.deliverTx(txBytesSigned(t, "staking/register_validator", map[string]any{
		"validatorId": "v1",
		"pubKey":      []byte(pub),
		"power":       1,
	}, "v1"), height, 0))

	tx := txBytesSigned(t, "staking/bond", map[string]any{"validatorId": "v1", "amount": 1}, "v1")
	mustOk(t, a.deliverTx(tx, height, 0))

	res := a.deliverTx(tx, height, 0)
	if res.Code == 0 {
		t.Fatalf("expected replay to be rejected")
	}
	if !strings.Contains(res.Log, "replayed tx.nonce") {
		t.Fatalf("expected replay log to mention nonce, got %q", res.Log)
	}
}

func TestReplayProtection_RejectsNonNumericNonce(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	pub, priv := testEd25519Key("alice")
	value := map[string]any{"account": "alice", "pubKey": []byte(pub)}
	valueBytes := mustMarshal(t, value)

	nonce := "not-a-number"
	msg := txAuthSignBytesV0("auth/register_account", valueBytes, nonce, "alice")
	sig := ed25519.Sign(priv, msg)
	env := codec.TxEnvelope{
		Type:   "auth/register_account",
		Value:  valueBytes,
		Nonce:  nonce,
		Signer: "alice",
		Sig:    sig,
	}

	res := a.deliverTx(mustMarshal(t, env), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected non-numeric nonce to be rejected")
	}
	if !strings.Contains(res.Log, "invalid tx.nonce") {
		t.Fatalf("expected log to mention invalid tx.nonce, got %q", res.Log)
	}
}
