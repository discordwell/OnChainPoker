package committee

import (
	"bytes"
	"encoding/hex"
	"math/rand"
	"testing"
)

func fixedSalt(b byte) []byte {
	s := make([]byte, BeaconSaltBytes)
	for i := range s {
		s[i] = b
	}
	return s
}

func TestCommitReveal_RoundTrip(t *testing.T) {
	epochID := uint64(42)
	val := "cosmosvaloper1testa"
	salt := fixedSalt(0xAB)

	c, err := Commit(val, epochID, salt)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if len(c) != BeaconCommitBytes {
		t.Fatalf("commit length: got %d want %d", len(c), BeaconCommitBytes)
	}

	if err := Reveal(val, epochID, salt, c[:]); err != nil {
		t.Fatalf("Reveal accepted matching salt but errored: %v", err)
	}
}

func TestCommitReveal_WrongSaltRejected(t *testing.T) {
	epochID := uint64(7)
	val := "cosmosvaloper1a"
	good := fixedSalt(0x01)
	bad := fixedSalt(0x02)

	c, err := Commit(val, epochID, good)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}

	if err := Reveal(val, epochID, bad, c[:]); err == nil {
		t.Fatalf("Reveal accepted wrong salt")
	}
}

func TestCommitReveal_WrongEpochRejected(t *testing.T) {
	val := "cosmosvaloper1a"
	salt := fixedSalt(0x01)

	c, err := Commit(val, 1, salt)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	if err := Reveal(val, 2, salt, c[:]); err == nil {
		t.Fatalf("Reveal accepted cross-epoch reveal")
	}
}

func TestCommit_InvalidInputs(t *testing.T) {
	if _, err := Commit("", 1, fixedSalt(0)); err == nil {
		t.Fatalf("expected error for empty validator")
	}
	if _, err := Commit("v", 1, []byte{1, 2, 3}); err == nil {
		t.Fatalf("expected error for short salt")
	}
}

func TestReveal_InvalidCommitLength(t *testing.T) {
	if err := Reveal("v", 1, fixedSalt(0), []byte{0, 1, 2}); err == nil {
		t.Fatalf("expected error for malformed stored commit")
	}
}

func TestFinal_DeterministicSameReveals(t *testing.T) {
	chainID := "poker-main-1"
	epochID := uint64(100)
	revs := []BeaconReveal{
		{Validator: "a", Salt: fixedSalt(1)},
		{Validator: "b", Salt: fixedSalt(2)},
		{Validator: "c", Salt: fixedSalt(3)},
	}

	out1, ok, err := Final(chainID, epochID, revs, len(revs))
	if err != nil {
		t.Fatalf("Final: %v", err)
	}
	if !ok {
		t.Fatalf("expected ok=true with enough reveals")
	}
	out2, _, _ := Final(chainID, epochID, revs, len(revs))
	if out1 != out2 {
		t.Fatalf("Final is non-deterministic")
	}
}

func TestFinal_OrderInvariant(t *testing.T) {
	chainID := "poker-main-1"
	epochID := uint64(100)
	revs := []BeaconReveal{
		{Validator: "a", Salt: fixedSalt(1)},
		{Validator: "b", Salt: fixedSalt(2)},
		{Validator: "c", Salt: fixedSalt(3)},
		{Validator: "d", Salt: fixedSalt(4)},
	}

	out1, _, err := Final(chainID, epochID, revs, len(revs))
	if err != nil {
		t.Fatalf("Final: %v", err)
	}

	// Shuffle with a deterministic seed so the test is reproducible.
	shuffled := append([]BeaconReveal(nil), revs...)
	r := rand.New(rand.NewSource(0xDEADBEEF))
	r.Shuffle(len(shuffled), func(i, j int) { shuffled[i], shuffled[j] = shuffled[j], shuffled[i] })

	out2, _, err := Final(chainID, epochID, shuffled, len(shuffled))
	if err != nil {
		t.Fatalf("Final (shuffled): %v", err)
	}
	if out1 != out2 {
		t.Fatalf("Final changed with reveal order:\n got %s\nwant %s", hex.EncodeToString(out2[:]), hex.EncodeToString(out1[:]))
	}
}

func TestFinal_BelowThresholdFallsBack(t *testing.T) {
	chainID := "poker-main-1"
	epochID := uint64(100)
	revs := []BeaconReveal{
		{Validator: "a", Salt: fixedSalt(1)},
		{Validator: "b", Salt: fixedSalt(2)},
	}

	_, ok, err := Final(chainID, epochID, revs, 3)
	if err != nil {
		t.Fatalf("Final: %v", err)
	}
	if ok {
		t.Fatalf("expected ok=false below threshold")
	}
}

func TestFinal_RejectsDuplicateValidator(t *testing.T) {
	revs := []BeaconReveal{
		{Validator: "a", Salt: fixedSalt(1)},
		{Validator: "a", Salt: fixedSalt(2)},
	}
	if _, _, err := Final("cid", 1, revs, 1); err == nil {
		t.Fatalf("expected error for duplicate validator")
	}
}

func TestFinal_RejectsBadSalt(t *testing.T) {
	revs := []BeaconReveal{
		{Validator: "a", Salt: []byte{1, 2, 3}},
	}
	if _, _, err := Final("cid", 1, revs, 1); err == nil {
		t.Fatalf("expected error for short salt")
	}
}

func TestFinal_DifferentEpochsDiffer(t *testing.T) {
	revs := []BeaconReveal{
		{Validator: "a", Salt: fixedSalt(1)},
		{Validator: "b", Salt: fixedSalt(2)},
	}
	out1, _, err := Final("cid", 1, revs, 2)
	if err != nil {
		t.Fatalf("Final e1: %v", err)
	}
	out2, _, err := Final("cid", 2, revs, 2)
	if err != nil {
		t.Fatalf("Final e2: %v", err)
	}
	if bytes.Equal(out1[:], out2[:]) {
		t.Fatalf("different epochs produced same beacon")
	}
}

func TestFinal_DifferentChainIDsDiffer(t *testing.T) {
	revs := []BeaconReveal{
		{Validator: "a", Salt: fixedSalt(1)},
	}
	out1, _, err := Final("chainA", 1, revs, 1)
	if err != nil {
		t.Fatalf("Final A: %v", err)
	}
	out2, _, err := Final("chainB", 1, revs, 1)
	if err != nil {
		t.Fatalf("Final B: %v", err)
	}
	if bytes.Equal(out1[:], out2[:]) {
		t.Fatalf("different chainIDs produced same beacon")
	}
}

func TestMissingReveals(t *testing.T) {
	commits := []BeaconCommit{
		{Validator: "a", Commit: fixedSalt(0)}, // content doesn't matter for MissingReveals
		{Validator: "b", Commit: fixedSalt(0)},
		{Validator: "c", Commit: fixedSalt(0)},
	}
	revs := []BeaconReveal{
		{Validator: "a", Salt: fixedSalt(1)},
	}
	missing := MissingReveals(commits, revs)
	if len(missing) != 2 || missing[0] != "b" || missing[1] != "c" {
		t.Fatalf("MissingReveals = %v, want [b c]", missing)
	}
}

func TestIsDevnetChainID(t *testing.T) {
	yes := []string{"ocp-devnet-1", "ocp-local-1", "DEVNET", "Local-42", "foo-bar-local"}
	no := []string{"ocp-main-1", "poker-mainnet", "prod", "", "cosmoshub-4"}
	for _, s := range yes {
		if !IsDevnetChainID(s) {
			t.Errorf("IsDevnetChainID(%q) = false, want true", s)
		}
	}
	for _, s := range no {
		if IsDevnetChainID(s) {
			t.Errorf("IsDevnetChainID(%q) = true, want false", s)
		}
	}
}

func TestVerifyCommitSyntax(t *testing.T) {
	ok := make([]byte, BeaconCommitBytes)
	if err := VerifyCommitSyntax(ok); err != nil {
		t.Errorf("expected ok, got %v", err)
	}
	if err := VerifyCommitSyntax(nil); err == nil {
		t.Errorf("expected error for nil commit")
	}
	if err := VerifyCommitSyntax(make([]byte, BeaconCommitBytes-1)); err == nil {
		t.Errorf("expected error for short commit")
	}
}

// Sanity: Commit uses a different domain than the final beacon, so a committed
// value can never be mistaken for a beacon output (domain separation).
func TestCommit_DomainSeparation(t *testing.T) {
	val := "v"
	epochID := uint64(1)
	salt := fixedSalt(0x77)
	c, err := Commit(val, epochID, salt)
	if err != nil {
		t.Fatalf("Commit: %v", err)
	}
	out, _, err := Final("cid", epochID, []BeaconReveal{{Validator: val, Salt: salt}}, 1)
	if err != nil {
		t.Fatalf("Final: %v", err)
	}
	if bytes.Equal(c[:], out[:]) {
		t.Fatalf("commit collides with final beacon (domain separation broken)")
	}
}

func TestSha256SumSanity(t *testing.T) {
	// Guard against accidental refactor of sha256Sum breaking.
	h := sha256Sum([]byte("abc"))
	want := "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	if hex.EncodeToString(h[:]) != want {
		t.Fatalf("sha256Sum mismatch")
	}
}
