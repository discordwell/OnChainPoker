package committee

import (
	"context"
	"testing"

	sdkmath "cosmossdk.io/math"

	sdked25519 "github.com/cosmos/cosmos-sdk/crypto/keys/ed25519"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
)

type fakeBondedStakingKeeper struct {
	vals []stakingtypes.Validator
	err  error
}

func (k fakeBondedStakingKeeper) GetBondedValidatorsByPower(_ context.Context) ([]stakingtypes.Validator, error) {
	return k.vals, k.err
}

func TestBondedMemberSnapshots_ValidatesAndSorts(t *testing.T) {
	makeVal := func(op string, power int64, pkByte byte) stakingtypes.Validator {
		pk := &sdked25519.PubKey{Key: bytesRepeat(pkByte, 32)}
		val, err := stakingtypes.NewValidator(op, pk, stakingtypes.NewDescription("", "", "", "", ""))
		if err != nil {
			t.Fatalf("NewValidator: %v", err)
		}
		val.Status = stakingtypes.Bonded
		val.Tokens = sdkmath.NewInt(power * 1_000_000)
		return val
	}

	// Deliberately unsorted input to ensure we canonicalize.
	k := fakeBondedStakingKeeper{
		vals: []stakingtypes.Validator{
			makeVal("valoper1bbb", 2, 0xbb),
			makeVal("valoper1aaa", 1, 0xaa),
		},
	}

	snaps, err := BondedMemberSnapshots(context.Background(), k)
	if err != nil {
		t.Fatalf("BondedMemberSnapshots: %v", err)
	}
	if len(snaps) != 2 {
		t.Fatalf("expected 2 snapshots, got %d", len(snaps))
	}
	if snaps[0].Operator != "valoper1aaa" || snaps[1].Operator != "valoper1bbb" {
		t.Fatalf("unexpected order: %q, %q", snaps[0].Operator, snaps[1].Operator)
	}
	if snaps[0].Power != 1 || snaps[1].Power != 2 {
		t.Fatalf("unexpected powers: %d, %d", snaps[0].Power, snaps[1].Power)
	}
	if len(snaps[0].ConsPubKey) != 32 || len(snaps[1].ConsPubKey) != 32 {
		t.Fatalf("expected 32-byte consensus pubkeys, got %d and %d", len(snaps[0].ConsPubKey), len(snaps[1].ConsPubKey))
	}
	if snaps[0].ConsPubKey[0] != 0xaa || snaps[1].ConsPubKey[0] != 0xbb {
		t.Fatalf("unexpected pubkey bytes")
	}
}

func TestBondedMemberSnapshots_RejectsNonEd25519PubKeyLength(t *testing.T) {
	pk := &sdked25519.PubKey{Key: bytesRepeat(0xaa, 31)}
	val, err := stakingtypes.NewValidator("valoper1aaa", pk, stakingtypes.NewDescription("", "", "", "", ""))
	if err != nil {
		t.Fatalf("NewValidator: %v", err)
	}
	val.Status = stakingtypes.Bonded
	val.Tokens = sdkmath.NewInt(1_000_000)

	k := fakeBondedStakingKeeper{vals: []stakingtypes.Validator{val}}
	if _, err := BondedMemberSnapshots(context.Background(), k); err == nil {
		t.Fatalf("expected error for invalid consensus pubkey length")
	}
}

func bytesRepeat(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}
