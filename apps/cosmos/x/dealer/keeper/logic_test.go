package keeper

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
)

// pointToCardIDLinear is the pre-optimization linear-scan implementation,
// kept here only so the benchmark can compare old vs new on the same inputs.
func pointToCardIDLinear(p ocpcrypto.Point, deckSize int) (uint32, error) {
	if deckSize <= 0 || deckSize > 52 {
		deckSize = 52
	}
	for c := 0; c < deckSize; c++ {
		if ocpcrypto.PointEq(p, cardPoint(c)) {
			return uint32(c), nil
		}
	}
	return 0, fmt.Errorf("plaintext does not map to a known card id")
}

func TestPointToCardID_RoundTrip(t *testing.T) {
	for c := 0; c < 52; c++ {
		got, err := pointToCardID(cardPoint(c), 52)
		require.NoError(t, err, "c=%d", c)
		require.Equal(t, uint32(c), got, "c=%d", c)
	}
}

func TestPointToCardID_RespectsDeckSize(t *testing.T) {
	// A card point whose id is >= deckSize must be rejected: pointToCardID
	// previously restricted its linear scan to [0, deckSize), and the
	// optimized version must match that behavior.
	p := cardPoint(30)
	_, err := pointToCardID(p, 20)
	require.Error(t, err)
	require.Contains(t, err.Error(), "plaintext does not map to a known card id")

	// Within range it still resolves.
	got, err := pointToCardID(p, 40)
	require.NoError(t, err)
	require.Equal(t, uint32(30), got)
}

func TestPointToCardID_OutOfDeck(t *testing.T) {
	// cardPoint(60) is a valid group element but not one of the 52 card
	// points, so it must be rejected. deckSize=52 is clamped-equivalent to
	// the default, so cardPoint(60) is never visited.
	_, err := pointToCardID(cardPoint(60), 52)
	require.Error(t, err)
	require.Contains(t, err.Error(), "plaintext does not map to a known card id")
}

func TestPointToCardID_NonCardPoint(t *testing.T) {
	// The identity element is not any cardPoint(c) for c in [0, 52).
	_, err := pointToCardID(ocpcrypto.PointZero(), 52)
	require.Error(t, err)
	require.Contains(t, err.Error(), "plaintext does not map to a known card id")

	// An arbitrary base multiple well outside the card range.
	arb := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1_000_003))
	_, err = pointToCardID(arb, 52)
	require.Error(t, err)
}

func TestPointToCardID_DeckSizeClamp(t *testing.T) {
	// deckSize <= 0 or > 52 clamps to 52 (matches pre-optimization contract).
	for _, ds := range []int{-1, 0, 53, 1000} {
		got, err := pointToCardID(cardPoint(51), ds)
		require.NoError(t, err, "ds=%d", ds)
		require.Equal(t, uint32(51), got, "ds=%d", ds)
	}
}

// Benchmarks: run with
//   go test -bench=BenchmarkPointToCardID -run=^$ ./apps/cosmos/x/dealer/keeper/...

func BenchmarkPointToCardIDLinear(b *testing.B) {
	// Hit a worst-ish case for the linear scan: last card.
	p := cardPoint(51)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := pointToCardIDLinear(p, 52); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPointToCardID(b *testing.B) {
	p := cardPoint(51)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := pointToCardID(p, 52); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPointToCardIDLinear_Average(b *testing.B) {
	// Iterate through all 52 cards so the benchmark reflects average work
	// over the whole deck rather than the worst case.
	points := make([]ocpcrypto.Point, 52)
	for c := 0; c < 52; c++ {
		points[c] = cardPoint(c)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := pointToCardIDLinear(points[i%52], 52); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkPointToCardID_Average(b *testing.B) {
	points := make([]ocpcrypto.Point, 52)
	for c := 0; c < 52; c++ {
		points[c] = cardPoint(c)
	}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := pointToCardID(points[i%52], 52); err != nil {
			b.Fatal(err)
		}
	}
}
