package keeper

import (
	"bytes"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
	pokertypes "onchainpoker/apps/cosmos/x/poker/types"
)

func TestDkgCommit_DeadlinePassed(t *testing.T) {
	valoper := sdk.ValAddress(bytes.Repeat([]byte{0x21}, 20)).String()
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 11, nil)

	require.NoError(t, k.SetDKG(ctx, &dealertypes.DealerDKG{
		EpochId:           7,
		Threshold:         1,
		Members:           []dealertypes.DealerMember{{Validator: valoper, Index: 1}},
		StartHeight:       1,
		CommitDeadline:    10,
		ComplaintDeadline: 12,
		RevealDeadline:    14,
		FinalizeDeadline:  16,
	}))

	commitment := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(1)).Bytes()
	_, err := ms.DkgCommit(ctx, &dealertypes.MsgDkgCommit{
		Dealer:      valoper,
		EpochId:     7,
		Commitments: [][]byte{commitment},
	})
	require.ErrorContains(t, err, "commit deadline passed")

	dkg, getErr := k.GetDKG(ctx)
	require.NoError(t, getErr)
	require.NotNil(t, dkg)
	require.Len(t, dkg.Commits, 0)
}

func TestDkgCommit_DuplicateRejected(t *testing.T) {
	valoper := sdk.ValAddress(bytes.Repeat([]byte{0x22}, 20)).String()
	ctx, k, ms, _ := newDealerMsgServerForOverflowTests(t, time.Unix(100, 0).UTC(), 10, nil)

	commitment := ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(5)).Bytes()
	require.NoError(t, k.SetDKG(ctx, &dealertypes.DealerDKG{
		EpochId:           8,
		Threshold:         1,
		Members:           []dealertypes.DealerMember{{Validator: valoper, Index: 1}},
		StartHeight:       1,
		CommitDeadline:    20,
		ComplaintDeadline: 30,
		RevealDeadline:    40,
		FinalizeDeadline:  50,
		Commits: []dealertypes.DealerDKGCommit{
			{Dealer: valoper, Commitments: [][]byte{append([]byte(nil), commitment...)}},
		},
	}))

	_, err := ms.DkgCommit(ctx, &dealertypes.MsgDkgCommit{
		Dealer:      valoper,
		EpochId:     8,
		Commitments: [][]byte{commitment},
	})
	require.ErrorContains(t, err, "commit already submitted")

	dkg, getErr := k.GetDKG(ctx)
	require.NoError(t, getErr)
	require.NotNil(t, dkg)
	require.Len(t, dkg.Commits, 1)
}

func TestSubmitPubShare_RevealDeadlinePassed(t *testing.T) {
	valoper := sdk.ValAddress(bytes.Repeat([]byte{0x31}, 20)).String()
	ctx, _, ms, pokerKeeper := newDealerMsgServerForOverflowTests(t, time.Unix(200, 0).UTC(), 1, nil)

	require.NoError(t, pokerKeeper.SetTable(ctx, &pokertypes.Table{
		Id: 1,
		Hand: &pokertypes.Hand{
			HandId: 1,
			Dealer: &pokertypes.DealerMeta{
				RevealPos:      0,
				RevealDeadline: 200,
			},
		},
	}))

	_, err := ms.SubmitPubShare(ctx, &dealertypes.MsgSubmitPubShare{
		Validator:  valoper,
		TableId:    1,
		HandId:     1,
		Pos:        0,
		PubShare:   []byte{0x01},
		ProofShare: []byte{0x01},
	})
	require.ErrorContains(t, err, "reveal deadline passed; call dealer/timeout")
}

func TestSubmitPubShare_DuplicateRejected(t *testing.T) {
	valoper := sdk.ValAddress(bytes.Repeat([]byte{0x32}, 20)).String()
	ctx, k, ms, pokerKeeper := newDealerMsgServerForOverflowTests(t, time.Unix(200, 0).UTC(), 1, nil)

	require.NoError(t, k.SetEpoch(ctx, &dealertypes.DealerEpoch{
		EpochId:   9,
		Threshold: 1,
		Members: []dealertypes.DealerMember{
			{
				Validator: valoper,
				Index:     1,
			},
		},
	}))

	require.NoError(t, pokerKeeper.SetTable(ctx, &pokertypes.Table{
		Id: 1,
		Hand: &pokertypes.Hand{
			HandId: 1,
			Dealer: &pokertypes.DealerMeta{
				RevealPos:      0,
				RevealDeadline: 300,
			},
		},
	}))

	require.NoError(t, k.SetHand(ctx, 1, 1, &dealertypes.DealerHand{
		EpochId:  9,
		DeckSize: 1,
		Deck: []dealertypes.DealerCiphertext{
			{C1: []byte{0x00}, C2: []byte{0x00}},
		},
		PubShares: []dealertypes.DealerPubShare{
			{
				Pos:       0,
				Validator: valoper,
				Index:     1,
				Share:     []byte{0x01},
				Proof:     []byte{0x02},
			},
		},
	}))

	_, err := ms.SubmitPubShare(ctx, &dealertypes.MsgSubmitPubShare{
		Validator:  valoper,
		TableId:    1,
		HandId:     1,
		Pos:        0,
		PubShare:   []byte{0x03},
		ProofShare: []byte{0x04},
	})
	require.ErrorContains(t, err, "duplicate pub share")

	dh, getErr := k.GetHand(ctx, 1, 1)
	require.NoError(t, getErr)
	require.NotNil(t, dh)
	require.Len(t, dh.PubShares, 1)
}
