package keeper

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/require"

	"onchainpoker/apps/cosmos/x/dealer/types"
)

// makeSampleDKG returns a deterministically-populated DealerDKG suitable for
// transcript-root testing. All fields that the v2 encoding covers are set.
func makeSampleDKG() *types.DealerDKG {
	return &types.DealerDKG{
		EpochId:   42,
		Threshold: 3,
		Members: []types.DealerMember{
			{
				Validator:  "cosmosvaloper1aaa",
				Index:      1,
				PubShare:   []byte{0xDE, 0xAD}, // excluded from transcript on purpose
				ConsPubkey: []byte{0x01, 0x02, 0x03},
				Power:      100,
			},
			{
				Validator:  "cosmosvaloper1bbb",
				Index:      2,
				ConsPubkey: []byte{0x04, 0x05, 0x06},
				Power:      200,
			},
			{
				Validator:  "cosmosvaloper1ccc",
				Index:      3,
				ConsPubkey: []byte{0x07, 0x08, 0x09},
				Power:      300,
			},
		},
		StartHeight:       10,
		CommitDeadline:    20,
		ComplaintDeadline: 30,
		RevealDeadline:    40,
		FinalizeDeadline:  50,
		RandEpoch:         []byte{0xAA, 0xBB, 0xCC},
		Commits: []types.DealerDKGCommit{
			{
				Dealer:      "cosmosvaloper1aaa",
				Commitments: [][]byte{{0x11}, {0x22, 0x33}},
			},
			{
				Dealer:      "cosmosvaloper1bbb",
				Commitments: [][]byte{{0x44}},
			},
		},
		Complaints: []types.DealerDKGComplaint{
			{
				EpochId:    42,
				Complainer: "cosmosvaloper1aaa",
				Dealer:     "cosmosvaloper1bbb",
				Kind:       "missing",
				ShareMsg:   []byte{0x55, 0x66},
			},
		},
		Reveals: []types.DealerDKGShareReveal{
			{
				EpochId: 42,
				Dealer:  "cosmosvaloper1aaa",
				To:      "cosmosvaloper1bbb",
				Share:   []byte{0x77, 0x88},
			},
		},
		Slashed: []string{"cosmosvaloper1xyz"},
	}
}

func TestDKGTranscriptRoot_NilDKG(t *testing.T) {
	_, err := dkgTranscriptRoot(nil)
	require.Error(t, err)
}

func TestDKGTranscriptRoot_Deterministic(t *testing.T) {
	dkg := makeSampleDKG()
	r1, err := dkgTranscriptRoot(dkg)
	require.NoError(t, err)
	r2, err := dkgTranscriptRoot(dkg)
	require.NoError(t, err)
	require.Equal(t, r1, r2, "identical inputs must produce identical root")
	require.Len(t, r1, 32, "sha256 output must be 32 bytes")
}

func TestDKGTranscriptRoot_SortIndependent(t *testing.T) {
	canonical := makeSampleDKG()
	canonicalRoot, err := dkgTranscriptRoot(canonical)
	require.NoError(t, err)

	// Shuffle every ordered slice into a non-canonical order. The transcript
	// must still produce the same root because the function sorts defensively.
	shuffled := makeSampleDKG()
	shuffled.Members[0], shuffled.Members[2] = shuffled.Members[2], shuffled.Members[0]
	shuffled.Commits[0], shuffled.Commits[1] = shuffled.Commits[1], shuffled.Commits[0]
	// Add a second complaint so we actually have something to reorder.
	shuffled.Complaints = append(shuffled.Complaints, types.DealerDKGComplaint{
		EpochId:    42,
		Complainer: "cosmosvaloper1ccc",
		Dealer:     "cosmosvaloper1aaa",
		Kind:       "invalid",
		ShareMsg:   []byte{0x99},
	})
	canonical.Complaints = append(canonical.Complaints, types.DealerDKGComplaint{
		EpochId:    42,
		Complainer: "cosmosvaloper1ccc",
		Dealer:     "cosmosvaloper1aaa",
		Kind:       "invalid",
		ShareMsg:   []byte{0x99},
	})
	// Reverse the shuffled complaints so ordering differs.
	shuffled.Complaints[0], shuffled.Complaints[1] = shuffled.Complaints[1], shuffled.Complaints[0]

	// Recompute canonical after appending to keep inputs equal modulo order.
	canonicalRoot, err = dkgTranscriptRoot(canonical)
	require.NoError(t, err)
	shuffledRoot, err := dkgTranscriptRoot(shuffled)
	require.NoError(t, err)
	require.Equal(t, canonicalRoot, shuffledRoot, "sort order should not affect the root")
}

func TestDKGTranscriptRoot_PubShareExcluded(t *testing.T) {
	base := makeSampleDKG()
	baseRoot, err := dkgTranscriptRoot(base)
	require.NoError(t, err)

	mutated := makeSampleDKG()
	// Change PubShare on every member; root must remain unchanged because
	// PubShare is derived output, not a transcript input.
	for i := range mutated.Members {
		mutated.Members[i].PubShare = []byte{byte(i + 1), 0xFF}
	}
	mutatedRoot, err := dkgTranscriptRoot(mutated)
	require.NoError(t, err)
	require.Equal(t, baseRoot, mutatedRoot, "PubShare must not contribute to transcript root")
}

func TestDKGTranscriptRoot_FieldSensitivity(t *testing.T) {
	base := makeSampleDKG()
	baseRoot, err := dkgTranscriptRoot(base)
	require.NoError(t, err)

	cases := []struct {
		name   string
		mutate func(d *types.DealerDKG)
	}{
		{"EpochId", func(d *types.DealerDKG) { d.EpochId = 99 }},
		{"Threshold", func(d *types.DealerDKG) { d.Threshold = 4 }},
		{"StartHeight", func(d *types.DealerDKG) { d.StartHeight = 11 }},
		{"CommitDeadline", func(d *types.DealerDKG) { d.CommitDeadline = 21 }},
		{"ComplaintDeadline", func(d *types.DealerDKG) { d.ComplaintDeadline = 31 }},
		{"RevealDeadline", func(d *types.DealerDKG) { d.RevealDeadline = 41 }},
		{"FinalizeDeadline", func(d *types.DealerDKG) { d.FinalizeDeadline = 51 }},
		{"RandEpoch", func(d *types.DealerDKG) { d.RandEpoch = []byte{0xDE, 0xAD, 0xBE, 0xEF} }},
		{"MemberValidator", func(d *types.DealerDKG) { d.Members[0].Validator = "cosmosvaloper1zzz" }},
		{"MemberIndex", func(d *types.DealerDKG) { d.Members[0].Index = 99 }},
		{"MemberPower", func(d *types.DealerDKG) { d.Members[0].Power = 999 }},
		{"MemberConsPubkey", func(d *types.DealerDKG) { d.Members[0].ConsPubkey = []byte{0xFF} }},
		{"CommitDealer", func(d *types.DealerDKG) { d.Commits[0].Dealer = "cosmosvaloper1zzz" }},
		{"CommitBytes", func(d *types.DealerDKG) { d.Commits[0].Commitments[0] = []byte{0xEE} }},
		{"CommitCount", func(d *types.DealerDKG) {
			d.Commits[0].Commitments = append(d.Commits[0].Commitments, []byte{0xAB})
		}},
		{"ComplaintEpoch", func(d *types.DealerDKG) { d.Complaints[0].EpochId = 43 }},
		{"ComplaintComplainer", func(d *types.DealerDKG) { d.Complaints[0].Complainer = "cosmosvaloper1zzz" }},
		{"ComplaintDealer", func(d *types.DealerDKG) { d.Complaints[0].Dealer = "cosmosvaloper1zzz" }},
		{"ComplaintKind", func(d *types.DealerDKG) { d.Complaints[0].Kind = "other" }},
		{"ComplaintShareMsg", func(d *types.DealerDKG) { d.Complaints[0].ShareMsg = []byte{0xFF} }},
		{"RevealEpoch", func(d *types.DealerDKG) { d.Reveals[0].EpochId = 43 }},
		{"RevealDealer", func(d *types.DealerDKG) { d.Reveals[0].Dealer = "cosmosvaloper1zzz" }},
		{"RevealTo", func(d *types.DealerDKG) { d.Reveals[0].To = "cosmosvaloper1zzz" }},
		{"RevealShare", func(d *types.DealerDKG) { d.Reveals[0].Share = []byte{0xFF} }},
		{"Slashed", func(d *types.DealerDKG) { d.Slashed = append(d.Slashed, "cosmosvaloper1new") }},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			m := makeSampleDKG()
			tc.mutate(m)
			r, err := dkgTranscriptRoot(m)
			require.NoError(t, err)
			require.NotEqual(t, baseRoot, r, "mutating %s must change the root", tc.name)
		})
	}
}

// TestDKGTranscriptRoot_DomainSeparator guards against accidental domain
// regression (dropping the v2 suffix would recreate the legacy hash).
func TestDKGTranscriptRoot_DomainSeparator(t *testing.T) {
	require.Equal(t, "ocp/v1/dkg/transcript/v2", dkgTranscriptDomain)
}

// TestDKGTranscriptRoot_LengthPrefixPreventsCollision ensures that the
// length-prefix framing protects against the classic collision where two
// different field partitions would otherwise concatenate to the same byte
// stream. Specifically, splitting "abc"+"" vs ""+"abc" in a len-prefixed
// framing must produce different roots.
func TestDKGTranscriptRoot_LengthPrefixPreventsCollision(t *testing.T) {
	a := makeSampleDKG()
	a.Members[0].Validator = "abc"
	a.Members[0].ConsPubkey = []byte{}
	b := makeSampleDKG()
	b.Members[0].Validator = ""
	b.Members[0].ConsPubkey = []byte("abc")
	ra, err := dkgTranscriptRoot(a)
	require.NoError(t, err)
	rb, err := dkgTranscriptRoot(b)
	require.NoError(t, err)
	require.False(t, bytes.Equal(ra, rb), "length-prefix framing must distinguish boundary shifts")
}
