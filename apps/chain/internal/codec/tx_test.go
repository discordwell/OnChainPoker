package codec

import (
	"encoding/json"
	"testing"
)

func TestDecodeTxEnvelope_OK(t *testing.T) {
	b, err := json.Marshal(map[string]any{
		"type":  "bank/mint",
		"value": map[string]any{"to": "alice", "amount": 123},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	env, err := DecodeTxEnvelope(b)
	if err != nil {
		t.Fatalf("DecodeTxEnvelope: %v", err)
	}
	if env.Type != "bank/mint" {
		t.Fatalf("unexpected type: %q", env.Type)
	}

	var v map[string]any
	if err := json.Unmarshal(env.Value, &v); err != nil {
		t.Fatalf("unmarshal value: %v", err)
	}
	if v["to"] != "alice" {
		t.Fatalf("unexpected value.to: %#v", v["to"])
	}
}

func TestDecodeTxEnvelope_IgnoresUnknownFields(t *testing.T) {
	// v0 clients may include a throwaway nonce to keep tx bytes unique.
	b, err := json.Marshal(map[string]any{
		"type":  "bank/mint",
		"nonce": "7",
		"value": map[string]any{"to": "alice", "amount": 1},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	_, err = DecodeTxEnvelope(b)
	if err != nil {
		t.Fatalf("DecodeTxEnvelope: %v", err)
	}
}

func TestDecodeTxEnvelope_MissingType(t *testing.T) {
	b, err := json.Marshal(map[string]any{
		"value": map[string]any{"x": 1},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	_, err = DecodeTxEnvelope(b)
	if err == nil {
		t.Fatalf("expected error")
	}
}

func TestDecodeTxEnvelope_InvalidJSON(t *testing.T) {
	_, err := DecodeTxEnvelope([]byte("{not json"))
	if err == nil {
		t.Fatalf("expected error")
	}
}
