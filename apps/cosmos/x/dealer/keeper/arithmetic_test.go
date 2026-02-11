package keeper

import (
	"math"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAddInt64AndU64Checked(t *testing.T) {
	got, err := addInt64AndU64Checked(42, 10, "deadline")
	require.NoError(t, err)
	require.Equal(t, int64(52), got)
}

func TestAddInt64AndU64Checked_Overflow(t *testing.T) {
	_, err := addInt64AndU64Checked(math.MaxInt64, 1, "deadline")
	require.ErrorContains(t, err, "overflows int64")
	_, err = addInt64AndU64Checked(0, uint64(math.MaxInt64)+1, "deadline")
	require.ErrorContains(t, err, "overflows int64")
}

func TestAddUint64Checked_Overflow(t *testing.T) {
	got, err := addUint64Checked(10, 20, "id")
	require.NoError(t, err)
	require.Equal(t, uint64(30), got)

	_, err = addUint64Checked(^uint64(0), 1, "id")
	require.ErrorContains(t, err, "overflows uint64")
}
