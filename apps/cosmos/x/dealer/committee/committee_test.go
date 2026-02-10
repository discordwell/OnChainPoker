package committee

import (
	"encoding/hex"
	"testing"
)

func TestDevnetRandEpochFrom_IsStable(t *testing.T) {
	lastHash, _ := hex.DecodeString("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")
	got := DevnetRandEpochFrom("ocp-devnet-1", 123, lastHash, 7)
	wantHex := "d8f43536f8595a4a7beb7ffff4b22085434862113662e3a685a2e85ba6db781f"
	if hex.EncodeToString(got[:]) != wantHex {
		t.Fatalf("unexpected randEpoch\nwant %s\ngot  %s", wantHex, hex.EncodeToString(got[:]))
	}
}

func TestRandEpochOrDevnetFrom(t *testing.T) {
	lastHash, _ := hex.DecodeString("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff")

	derived, err := RandEpochOrDevnetFrom("ocp-devnet-1", 123, lastHash, 7, nil)
	if err != nil {
		t.Fatalf("RandEpochOrDevnetFrom (derived): %v", err)
	}
	wantDerived := DevnetRandEpochFrom("ocp-devnet-1", 123, lastHash, 7)
	if derived != wantDerived {
		t.Fatalf("derived randEpoch mismatch")
	}

	provided := make([]byte, 32)
	for i := range provided {
		provided[i] = byte(i)
	}
	gotProvided, err := RandEpochOrDevnetFrom("ocp-devnet-1", 123, lastHash, 7, provided)
	if err != nil {
		t.Fatalf("RandEpochOrDevnetFrom (provided): %v", err)
	}
	if hex.EncodeToString(gotProvided[:]) != hex.EncodeToString(provided) {
		t.Fatalf("provided randEpoch mismatch\nwant %s\ngot  %s", hex.EncodeToString(provided), hex.EncodeToString(gotProvided[:]))
	}

	if _, err := RandEpochOrDevnetFrom("ocp-devnet-1", 123, lastHash, 7, []byte{1, 2, 3}); err == nil {
		t.Fatalf("expected error for invalid randEpoch length")
	}
}

func TestSampleByPower_DeterministicAndUnique(t *testing.T) {
	var seed [32]byte
	copy(seed[:], []byte("0123456789abcdef0123456789abcdef"))

	cands := []PowerCandidate{
		{Operator: "valoper1aaa", Power: 10},
		{Operator: "valoper1bbb", Power: 20},
		{Operator: "valoper1ccc", Power: 30},
		{Operator: "valoper1ddd", Power: 40},
	}

	s1, err := SampleByPower(seed, cands, 3)
	if err != nil {
		t.Fatalf("SampleByPower: %v", err)
	}
	s2, err := SampleByPower(seed, cands, 3)
	if err != nil {
		t.Fatalf("SampleByPower (2): %v", err)
	}
	if len(s1) != 3 {
		t.Fatalf("expected 3 selected, got %d", len(s1))
	}
	for i := range s1 {
		if s1[i] != s2[i] {
			t.Fatalf("expected deterministic output, mismatch at %d: %q vs %q", i, s1[i], s2[i])
		}
	}

	seen := map[string]bool{}
	for _, op := range s1 {
		if seen[op] {
			t.Fatalf("duplicate selected operator: %s", op)
		}
		seen[op] = true
	}
}

func TestSampleCandidatesByPower_ReturnsPower(t *testing.T) {
	var seed [32]byte
	copy(seed[:], []byte("0123456789abcdef0123456789abcdef"))

	cands := []PowerCandidate{
		{Operator: "valoper1aaa", Power: 10},
		{Operator: "valoper1bbb", Power: 20},
		{Operator: "valoper1ccc", Power: 30},
		{Operator: "valoper1ddd", Power: 40},
	}

	s, err := SampleCandidatesByPower(seed, cands, 3)
	if err != nil {
		t.Fatalf("SampleCandidatesByPower: %v", err)
	}
	if len(s) != 3 {
		t.Fatalf("expected 3 selected, got %d", len(s))
	}

	powerByOp := map[string]int64{}
	for _, c := range cands {
		powerByOp[c.Operator] = c.Power
	}
	for _, m := range s {
		want, ok := powerByOp[m.Operator]
		if !ok {
			t.Fatalf("unexpected operator in output: %s", m.Operator)
		}
		if m.Power != want {
			t.Fatalf("power mismatch for %s: want %d got %d", m.Operator, want, m.Power)
		}
	}
}

func TestSampleByPower_RejectsDuplicateOperators(t *testing.T) {
	var seed [32]byte
	copy(seed[:], []byte("0123456789abcdef0123456789abcdef"))

	_, err := SampleByPower(seed, []PowerCandidate{
		{Operator: "valoper1dup", Power: 10},
		{Operator: "valoper1dup", Power: 20},
	}, 1)
	if err == nil {
		t.Fatalf("expected error for duplicate operators")
	}
}

func TestSampleByPower_SkipsZeroPower(t *testing.T) {
	var seed [32]byte
	copy(seed[:], []byte("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))

	cands := []PowerCandidate{
		{Operator: "valoper1aaa", Power: 0},
		{Operator: "valoper1bbb", Power: 10},
		{Operator: "valoper1ccc", Power: 10},
	}

	s, err := SampleByPower(seed, cands, 2)
	if err != nil {
		t.Fatalf("SampleByPower: %v", err)
	}
	for _, op := range s {
		if op == "valoper1aaa" {
			t.Fatalf("zero-power candidate should never be selected")
		}
	}
}

func TestSampleByPower_WeightedPreference(t *testing.T) {
	// With a 100:1 weight ratio, the heavy candidate should win "most" of the time
	// across many independent seeds.
	cands := []PowerCandidate{
		{Operator: "light", Power: 1},
		{Operator: "heavy", Power: 100},
	}

	heavyWins := 0
	const trials = 500
	for i := 0; i < trials; i++ {
		var seed [32]byte
		// Deterministic but varying seeds.
		seed[0] = byte(i)
		seed[1] = byte(i >> 8)
		seed[2] = byte(i >> 16)
		seed[3] = byte(i >> 24)

		s, err := SampleByPower(seed, cands, 1)
		if err != nil {
			t.Fatalf("SampleByPower trial %d: %v", i, err)
		}
		if s[0] == "heavy" {
			heavyWins++
		}
	}

	// Expected ~495/500; allow slack for deterministic PRF quirks while still catching "weights ignored" bugs.
	if heavyWins < 450 {
		t.Fatalf("unexpectedly low heavy selection count: got %d / %d", heavyWins, trials)
	}
}
