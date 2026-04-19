package ocpcrypto

import (
	"bytes"
	"testing"
)

// Backward-compatibility golden vector. Captured against the pre-fold
// implementation in both TS and Go; must remain unchanged after the fold
// is introduced because single-challenge callers see the same challenge
// digest. The TS and Go Transcript implementations are required to be
// bit-for-bit interoperable — this value is the same on both sides.
const singleChallengeGoldenHex = "a2e9007cc0b1a8acf959efd4e0a810bd90bc64b16d9b96b266c5f3b328960d05"

func TestTranscript_SingleChallengeGolden(t *testing.T) {
	// Backward-compat: one appendMessage + one challengeScalar must yield
	// exactly the pre-fold golden value.
	tr := NewTranscript("ocp/v1/test")
	if err := tr.AppendMessage("msg1", []byte{1, 2, 3, 4}); err != nil {
		t.Fatalf("append: %v", err)
	}
	e, err := tr.ChallengeScalar("e")
	if err != nil {
		t.Fatalf("challenge: %v", err)
	}
	want, err := hexToBytes(singleChallengeGoldenHex)
	if err != nil {
		t.Fatalf("hex: %v", err)
	}
	if !bytes.Equal(e.Bytes(), want) {
		t.Fatalf("single-challenge golden mismatch: got=%s want=%s",
			bytesToHex(e.Bytes()), bytesToHex(want))
	}
}

func TestTranscript_TwoChallengesDiffer(t *testing.T) {
	// Multi-challenge: the second challenge must differ from the first,
	// proving that the fold is actually binding subsequent challenges.
	tr := NewTranscript("ocp/v1/test")
	if err := tr.AppendMessage("msg1", []byte{1, 2, 3, 4}); err != nil {
		t.Fatalf("append: %v", err)
	}
	e1, err := tr.ChallengeScalar("e")
	if err != nil {
		t.Fatalf("challenge1: %v", err)
	}
	e2, err := tr.ChallengeScalar("e")
	if err != nil {
		t.Fatalf("challenge2: %v", err)
	}
	if bytes.Equal(e1.Bytes(), e2.Bytes()) {
		t.Fatalf("expected second challenge to differ from first; got %s for both",
			bytesToHex(e1.Bytes()))
	}
}

func TestTranscript_FirstChallengeUnchangedByLaterDraws(t *testing.T) {
	// The fold must not retroactively affect the first challenge.
	tr := NewTranscript("ocp/v1/test")
	if err := tr.AppendMessage("msg1", []byte{1, 2, 3, 4}); err != nil {
		t.Fatalf("append: %v", err)
	}
	e1, err := tr.ChallengeScalar("e")
	if err != nil {
		t.Fatalf("challenge1: %v", err)
	}
	// Draw a second challenge and confirm e1's bytes are unchanged.
	if _, err := tr.ChallengeScalar("e"); err != nil {
		t.Fatalf("challenge2: %v", err)
	}
	want, err := hexToBytes(singleChallengeGoldenHex)
	if err != nil {
		t.Fatalf("hex: %v", err)
	}
	if !bytes.Equal(e1.Bytes(), want) {
		t.Fatalf("first challenge mutated by second draw: got=%s want=%s",
			bytesToHex(e1.Bytes()), bytesToHex(want))
	}
}

func TestTranscript_SecondChallengeBindsInterveningMessage(t *testing.T) {
	// Two transcripts with the same first challenge but a different
	// inter-challenge message must produce different second challenges.
	trA := NewTranscript("ocp/v1/test")
	_ = trA.AppendMessage("m", []byte{0xaa})
	e1A, err := trA.ChallengeScalar("e")
	if err != nil {
		t.Fatalf("A.e1: %v", err)
	}
	_ = trA.AppendMessage("extra", []byte{0x01})
	e2A, err := trA.ChallengeScalar("e")
	if err != nil {
		t.Fatalf("A.e2: %v", err)
	}

	trB := NewTranscript("ocp/v1/test")
	_ = trB.AppendMessage("m", []byte{0xaa})
	e1B, err := trB.ChallengeScalar("e")
	if err != nil {
		t.Fatalf("B.e1: %v", err)
	}
	_ = trB.AppendMessage("extra", []byte{0x02})
	e2B, err := trB.ChallengeScalar("e")
	if err != nil {
		t.Fatalf("B.e2: %v", err)
	}

	if !bytes.Equal(e1A.Bytes(), e1B.Bytes()) {
		t.Fatalf("expected identical first challenges, got A=%s B=%s",
			bytesToHex(e1A.Bytes()), bytesToHex(e1B.Bytes()))
	}
	if bytes.Equal(e2A.Bytes(), e2B.Bytes()) {
		t.Fatalf("expected differing second challenges; both were %s",
			bytesToHex(e2A.Bytes()))
	}
}

func TestTranscript_SecondChallengeBindsFirstChallengeLabel(t *testing.T) {
	// Two transcripts identical except for the label used for the first
	// challenge. The first challenges differ (label flows into the
	// challenge hash). The second challenges must also differ, proving
	// that the fold tags the challenge with its label.
	trA := NewTranscript("ocp/v1/test")
	_ = trA.AppendMessage("m", []byte{0xaa})
	if _, err := trA.ChallengeScalar("e"); err != nil {
		t.Fatalf("A.e: %v", err)
	}
	e2A, err := trA.ChallengeScalar("e")
	if err != nil {
		t.Fatalf("A.e2: %v", err)
	}

	trB := NewTranscript("ocp/v1/test")
	_ = trB.AppendMessage("m", []byte{0xaa})
	if _, err := trB.ChallengeScalar("f"); err != nil {
		t.Fatalf("B.f: %v", err)
	}
	e2B, err := trB.ChallengeScalar("e")
	if err != nil {
		t.Fatalf("B.e2: %v", err)
	}

	if bytes.Equal(e2A.Bytes(), e2B.Bytes()) {
		t.Fatalf("expected differing second challenges when first labels differ; both were %s",
			bytesToHex(e2A.Bytes()))
	}
}
