package keeper

import (
	"bytes"
	"testing"

	"github.com/stretchr/testify/require"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
)

// saltFrom builds a deterministic 32-byte salt for tests.
func saltFrom(seed byte) []byte {
	out := make([]byte, 32)
	for i := range out {
		out[i] = seed
	}
	return out
}

func TestDeriveHandScalar_Deterministic(t *testing.T) {
	salt := saltFrom(0xab)

	k1, err := deriveHandScalar(1, 2, 3, 100, salt)
	require.NoError(t, err)

	k2, err := deriveHandScalar(1, 2, 3, 100, salt)
	require.NoError(t, err)

	require.Equal(t, k1.Bytes(), k2.Bytes(), "k_hand must be deterministic for identical inputs")
}

func TestDeriveHandScalar_RejectsBadSaltLength(t *testing.T) {
	_, err := deriveHandScalar(1, 2, 3, 100, nil)
	require.Error(t, err)
	require.Contains(t, err.Error(), "initSalt must be 32 bytes")

	_, err = deriveHandScalar(1, 2, 3, 100, make([]byte, 31))
	require.Error(t, err)
	require.Contains(t, err.Error(), "initSalt must be 32 bytes")

	_, err = deriveHandScalar(1, 2, 3, 100, make([]byte, 33))
	require.Error(t, err)
	require.Contains(t, err.Error(), "initSalt must be 32 bytes")

	// Exactly 32 bytes is fine.
	_, err = deriveHandScalar(1, 2, 3, 100, make([]byte, 32))
	require.NoError(t, err)
}

func TestDeriveHandScalar_DiffersOnInitHeight(t *testing.T) {
	salt := saltFrom(0xab)

	k1, err := deriveHandScalar(1, 2, 3, 100, salt)
	require.NoError(t, err)

	k2, err := deriveHandScalar(1, 2, 3, 101, salt)
	require.NoError(t, err)

	require.NotEqual(t, k1.Bytes(), k2.Bytes(), "k_hand must differ when initHeight differs")
}

func TestDeriveHandScalar_DiffersOnInitSalt(t *testing.T) {
	k1, err := deriveHandScalar(1, 2, 3, 100, saltFrom(0xab))
	require.NoError(t, err)

	k2, err := deriveHandScalar(1, 2, 3, 100, saltFrom(0xcd))
	require.NoError(t, err)

	require.NotEqual(t, k1.Bytes(), k2.Bytes(), "k_hand must differ when initHashSalt differs")

	// Single-bit difference must also produce a different scalar.
	saltA := saltFrom(0x00)
	saltB := saltFrom(0x00)
	saltB[17] ^= 0x01

	k3, err := deriveHandScalar(1, 2, 3, 100, saltA)
	require.NoError(t, err)
	k4, err := deriveHandScalar(1, 2, 3, 100, saltB)
	require.NoError(t, err)
	require.NotEqual(t, k3.Bytes(), k4.Bytes(), "single-bit salt flip must change k_hand")
}

func TestDeriveHandScalar_DiffersOnEpochTableHand(t *testing.T) {
	salt := saltFrom(0xab)

	base, err := deriveHandScalar(1, 2, 3, 100, salt)
	require.NoError(t, err)

	cases := []struct {
		name                       string
		epoch, table, hand         uint64
		height                     int64
	}{
		{"different epoch", 2, 2, 3, 100},
		{"different table", 1, 3, 3, 100},
		{"different hand", 1, 2, 4, 100},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			k, err := deriveHandScalar(tc.epoch, tc.table, tc.hand, tc.height, salt)
			require.NoError(t, err)
			require.NotEqual(t, base.Bytes(), k.Bytes(), "k_hand must depend on %s", tc.name)
		})
	}
}

// TestDeriveHandScalar_DomainRotation asserts that the v2 domain produces a
// fundamentally different k_hand than a hypothetical v1 recomputation would.
// This is a regression check: if somebody tries to reuse the v1 domain string
// with the new signature, they'd get a different output. We reproduce the v1
// derivation manually (without initHeight/initSalt) and confirm non-equality.
func TestDeriveHandScalar_DomainRotation_NoV1V2Collision(t *testing.T) {
	salt := saltFrom(0x11)
	const epochID, tableID, handID uint64 = 7, 11, 13
	const initHeight int64 = 42

	v2, err := deriveHandScalar(epochID, tableID, handID, initHeight, salt)
	require.NoError(t, err)

	// Manual v1 recomputation — legacy domain, no extra entropy.
	v1, err := ocpcrypto.HashToScalar(
		handDeriveDomain, // "ocp/v1/dealer/hand-derive"
		u64le(epochID),
		u64le(tableID),
		u64le(handID),
	)
	require.NoError(t, err)

	require.NotEqual(t, v1.Bytes(), v2.Bytes(),
		"legacy v1 derivation must not collide with v2 derivation")

	// Also: v2 with zero entropy still differs from v1, because the domain differs.
	zeroSalt := make([]byte, 32)
	v2Zero, err := deriveHandScalar(epochID, tableID, handID, 0, zeroSalt)
	require.NoError(t, err)
	require.NotEqual(t, v1.Bytes(), v2Zero.Bytes(),
		"v2 with zero entropy must still differ from v1 (domain separation)")
}

// TestI64le_LittleEndianEncoding pins the wire encoding we commit to for
// initHeight. Any change here is consensus-breaking and must bump the domain.
func TestI64le_LittleEndianEncoding(t *testing.T) {
	require.True(t, bytes.Equal(i64le(0), []byte{0, 0, 0, 0, 0, 0, 0, 0}))
	require.True(t, bytes.Equal(i64le(1), []byte{1, 0, 0, 0, 0, 0, 0, 0}))
	require.True(t, bytes.Equal(i64le(256), []byte{0, 1, 0, 0, 0, 0, 0, 0}))
	// -1 as uint64 is 0xFFFF_FFFF_FFFF_FFFF.
	require.True(t, bytes.Equal(i64le(-1),
		[]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}))
}
