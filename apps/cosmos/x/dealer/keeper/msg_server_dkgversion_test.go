package keeper

import (
	"bytes"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	sdk "github.com/cosmos/cosmos-sdk/types"

	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

// Under params.DkgVersion=1 (the default), DkgShareReveal is accepted as
// part of the existing legacy complaint/reveal flow. Regression guard.
func TestDkgShareReveal_AcceptedUnderV1(t *testing.T) {
	dealer := sdk.ValAddress(bytes.Repeat([]byte{0x31}, 20)).String()
	to := sdk.ValAddress(bytes.Repeat([]byte{0x32}, 20)).String()
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, nil)

	// Default params; DkgVersion == 1.
	require.NoError(t, k.SetParams(ctx, dealertypes.DefaultParams()))
	require.NoError(t, k.SetDKG(ctx, &dealertypes.DealerDKG{
		EpochId:   7,
		Threshold: 1,
		Members: []dealertypes.DealerMember{
			{Validator: dealer, Index: 1},
			{Validator: to, Index: 2},
		},
		StartHeight:       1,
		CommitDeadline:    100,
		ComplaintDeadline: 200,
		RevealDeadline:    300,
		FinalizeDeadline:  400,
		// For a reveal to be acceptable we also need a complaint filed
		// against the dealer by `to`.
		Complaints: []dealertypes.DealerDKGComplaint{
			{EpochId: 7, Complainer: to, Dealer: dealer, Kind: "missing"},
		},
	}))

	_, err := ms.DkgShareReveal(ctx, &dealertypes.MsgDkgShareReveal{
		Dealer:  dealer,
		EpochId: 7,
		To:      to,
		Share:   bytes.Repeat([]byte{0x01}, 32),
	})
	// May error for reasons unrelated to the version gate (e.g. missing
	// commit). What we're checking: the gate does NOT short-circuit with
	// the v2-disabled error message.
	if err != nil {
		require.NotContains(t, err.Error(), "disabled under DkgVersion")
	}
}

// Under params.DkgVersion=2, DkgShareReveal is rejected at the chain
// boundary before any other validation runs.
func TestDkgShareReveal_RejectedUnderV2(t *testing.T) {
	dealer := sdk.ValAddress(bytes.Repeat([]byte{0x41}, 20)).String()
	to := sdk.ValAddress(bytes.Repeat([]byte{0x42}, 20)).String()
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, nil)

	// Flip governance to v2.
	params := dealertypes.DefaultParams()
	params.DkgVersion = dealertypes.DkgVersionV2
	require.NoError(t, k.SetParams(ctx, params))
	require.NoError(t, k.SetDKG(ctx, &dealertypes.DealerDKG{
		EpochId:   7,
		Threshold: 1,
		Members: []dealertypes.DealerMember{
			{Validator: dealer, Index: 1},
			{Validator: to, Index: 2},
		},
		StartHeight:       1,
		CommitDeadline:    100,
		ComplaintDeadline: 200,
		RevealDeadline:    300,
		FinalizeDeadline:  400,
	}))

	_, err := ms.DkgShareReveal(ctx, &dealertypes.MsgDkgShareReveal{
		Dealer:  dealer,
		EpochId: 7,
		To:      to,
		Share:   bytes.Repeat([]byte{0x02}, 32),
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "disabled under DkgVersion")
}

// An empty DkgVersion field (e.g. pre-upgrade chain state that never set
// the param explicitly) must behave as v1. Regression guard for the
// DkgVersionOrDefault fallback.
func TestDkgShareReveal_EmptyVersionTreatedAsV1(t *testing.T) {
	dealer := sdk.ValAddress(bytes.Repeat([]byte{0x51}, 20)).String()
	to := sdk.ValAddress(bytes.Repeat([]byte{0x52}, 20)).String()
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, nil)

	// Params with DkgVersion left at zero.
	params := dealertypes.DefaultParams()
	params.DkgVersion = 0
	require.NoError(t, k.SetParams(ctx, params))
	require.NoError(t, k.SetDKG(ctx, &dealertypes.DealerDKG{
		EpochId:   7,
		Threshold: 1,
		Members: []dealertypes.DealerMember{
			{Validator: dealer, Index: 1},
			{Validator: to, Index: 2},
		},
		StartHeight:       1,
		CommitDeadline:    100,
		ComplaintDeadline: 200,
		RevealDeadline:    300,
		FinalizeDeadline:  400,
	}))

	_, err := ms.DkgShareReveal(ctx, &dealertypes.MsgDkgShareReveal{
		Dealer:  dealer,
		EpochId: 7,
		To:      to,
		Share:   bytes.Repeat([]byte{0x03}, 32),
	})
	if err != nil {
		require.NotContains(t, err.Error(), "disabled under DkgVersion")
	}
}

// Params.Validate rejects unknown DkgVersion values so bad governance txs
// fail at submission time rather than creating a chain that accepts no
// DKG msgs.
func TestParams_ValidateDkgVersion(t *testing.T) {
	cases := []struct {
		name    string
		version uint32
		wantErr bool
	}{
		{"zero accepted (legacy default)", 0, false},
		{"v1 accepted", 1, false},
		{"v2 accepted", 2, false},
		{"v3 rejected", 3, true},
		{"very large rejected", 100, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := dealertypes.DefaultParams()
			p.DkgVersion = tc.version
			err := p.Validate()
			if tc.wantErr {
				require.Error(t, err)
				require.Contains(t, err.Error(), "dkg_version")
			} else {
				require.NoError(t, err)
			}
		})
	}
}
