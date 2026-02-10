package keeper

import (
	"context"
	"fmt"
	"sort"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
	pokertypes "onchainpoker/apps/cosmos/x/poker/types"
)

// finalizeEpoch consumes an in-progress DKG and either:
// - finalizes a new active epoch (updating DealerEpoch, clearing DealerDKG), or
// - aborts the DKG (clearing DealerDKG), keeping the previous epoch.
//
// It returns events to be emitted by the caller.
func (m msgServer) finalizeEpoch(ctx context.Context, dkg *dealertypes.DealerDKG) ([]sdk.Event, error) {
	if dkg == nil {
		return nil, dealertypes.ErrNoDkgInFlight.Wrap("no dkg in progress")
	}

	events := []sdk.Event{}

	params, err := m.GetParams(ctx)
	if err != nil {
		return nil, err
	}
	slashFraction := bpsToDec(params.SlashBpsDkg)
	jailDuration := time.Duration(params.JailSecondsDkg) * time.Second

	// Slash for missing commits.
	for _, mem := range dkg.Members {
		if findDKGCommit(dkg, mem.Validator) != nil {
			continue
		}
		if !dkgSlash(dkg, mem.Validator) {
			continue
		}
		if err := m.applyPenalty(ctx, mem.Validator, dkg.StartHeight, mem.Power, slashFraction, jailDuration); err != nil {
			return nil, err
		}
		events = append(events, sdk.NewEvent(
			dealertypes.EventTypeValidatorSlashed,
			sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
			sdk.NewAttribute("validator", mem.Validator),
			sdk.NewAttribute("reason", "dkg-missing-commit"),
			sdk.NewAttribute("slashFraction", slashFraction.String()),
			sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", dkg.StartHeight)),
			sdk.NewAttribute("power", fmt.Sprintf("%d", mem.Power)),
		))
	}

	// Slash for unresolved complaints.
	for _, c := range dkg.Complaints {
		if dkgIsSlashed(dkg, c.Dealer) {
			continue
		}
		commit := findDKGCommit(dkg, c.Dealer)
		if commit == nil {
			if dkgSlash(dkg, c.Dealer) {
				dealerMem := findDKGMember(dkg, c.Dealer)
				power := int64(0)
				if dealerMem != nil {
					power = dealerMem.Power
				}
				if err := m.applyPenalty(ctx, c.Dealer, dkg.StartHeight, power, slashFraction, jailDuration); err != nil {
					return nil, err
				}
				events = append(events, sdk.NewEvent(
					dealertypes.EventTypeValidatorSlashed,
					sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
					sdk.NewAttribute("validator", c.Dealer),
					sdk.NewAttribute("reason", "dkg-missing-commit"),
					sdk.NewAttribute("slashFraction", slashFraction.String()),
					sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", dkg.StartHeight)),
					sdk.NewAttribute("power", fmt.Sprintf("%d", power)),
				))
			}
			continue
		}

		reveal := findDKGReveal(dkg, c.Dealer, c.Complainer)
		if reveal == nil {
			if dkgSlash(dkg, c.Dealer) {
				dealerMem := findDKGMember(dkg, c.Dealer)
				power := int64(0)
				if dealerMem != nil {
					power = dealerMem.Power
				}
				if err := m.applyPenalty(ctx, c.Dealer, dkg.StartHeight, power, slashFraction, jailDuration); err != nil {
					return nil, err
				}
				events = append(events, sdk.NewEvent(
					dealertypes.EventTypeValidatorSlashed,
					sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
					sdk.NewAttribute("validator", c.Dealer),
					sdk.NewAttribute("reason", "dkg-complaint-unresolved"),
					sdk.NewAttribute("slashFraction", slashFraction.String()),
					sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", dkg.StartHeight)),
					sdk.NewAttribute("power", fmt.Sprintf("%d", power)),
				))
			}
			continue
		}

		toMem := findDKGMember(dkg, c.Complainer)
		if toMem == nil {
			if dkgSlash(dkg, c.Dealer) {
				dealerMem := findDKGMember(dkg, c.Dealer)
				power := int64(0)
				if dealerMem != nil {
					power = dealerMem.Power
				}
				if err := m.applyPenalty(ctx, c.Dealer, dkg.StartHeight, power, slashFraction, jailDuration); err != nil {
					return nil, err
				}
				events = append(events, sdk.NewEvent(
					dealertypes.EventTypeValidatorSlashed,
					sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
					sdk.NewAttribute("validator", c.Dealer),
					sdk.NewAttribute("reason", "dkg-complaint-unresolved"),
					sdk.NewAttribute("slashFraction", slashFraction.String()),
					sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", dkg.StartHeight)),
					sdk.NewAttribute("power", fmt.Sprintf("%d", power)),
				))
			}
			continue
		}

		ok, err := dkgVerifyShare(commit.Commitments, toMem.Index, reveal.Share)
		if err != nil || !ok {
			if dkgSlash(dkg, c.Dealer) {
				dealerMem := findDKGMember(dkg, c.Dealer)
				power := int64(0)
				if dealerMem != nil {
					power = dealerMem.Power
				}
				if err := m.applyPenalty(ctx, c.Dealer, dkg.StartHeight, power, slashFraction, jailDuration); err != nil {
					return nil, err
				}
				events = append(events, sdk.NewEvent(
					dealertypes.EventTypeValidatorSlashed,
					sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
					sdk.NewAttribute("validator", c.Dealer),
					sdk.NewAttribute("reason", "dkg-invalid-share"),
					sdk.NewAttribute("slashFraction", slashFraction.String()),
					sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", dkg.StartHeight)),
					sdk.NewAttribute("power", fmt.Sprintf("%d", power)),
				))
			}
		}
	}

	qualDealers := make([]dealertypes.DealerMember, 0, len(dkg.Members))
	for _, mem := range dkg.Members {
		if dkgIsSlashed(dkg, mem.Validator) {
			continue
		}
		qualDealers = append(qualDealers, mem)
	}

	if len(qualDealers) < int(dkg.Threshold) {
		// Abort and clear in-progress DKG.
		if err := m.SetDKG(ctx, nil); err != nil {
			return nil, err
		}
		events = append(events, sdk.NewEvent(
			dealertypes.EventTypeDealerEpochAborted,
			sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
			sdk.NewAttribute("threshold", fmt.Sprintf("%d", dkg.Threshold)),
			sdk.NewAttribute("qual", fmt.Sprintf("%d", len(qualDealers))),
		))
		return events, nil
	}

	root, err := dkgTranscriptRoot(dkg)
	if err != nil {
		return nil, err
	}

	// Compute PK_E = sum_{i in QUAL} C_{i,0}.
	pk := ocpcrypto.PointZero()
	for _, mem := range qualDealers {
		commit := findDKGCommit(dkg, mem.Validator)
		if commit == nil || len(commit.Commitments) == 0 {
			continue
		}
		c0, err := ocpcrypto.PointFromBytesCanonical(commit.Commitments[0])
		if err != nil {
			return nil, err
		}
		pk = ocpcrypto.PointAdd(pk, c0)
	}

	// Compute per-validator public shares Y_j from QUAL commitments.
	membersOut := make([]dealertypes.DealerMember, 0, len(dkg.Members))
	for _, mem := range dkg.Members {
		x := mem.Index
		Y := ocpcrypto.PointZero()
		for _, dealer := range qualDealers {
			commit := findDKGCommit(dkg, dealer.Validator)
			if commit == nil {
				continue
			}
			pt, err := dkgEvalCommitment(commit.Commitments, x)
			if err != nil {
				return nil, err
			}
			Y = ocpcrypto.PointAdd(Y, pt)
		}
		mem.PubShare = Y.Bytes()
		membersOut = append(membersOut, mem)
	}

	// Canonicalize member ordering for deterministic epoch state.
	sort.Slice(membersOut, func(i, j int) bool {
		if membersOut[i].Validator != membersOut[j].Validator {
			return membersOut[i].Validator < membersOut[j].Validator
		}
		return membersOut[i].Index < membersOut[j].Index
	})

	epoch := &dealertypes.DealerEpoch{
		EpochId:        dkg.EpochId,
		Threshold:      dkg.Threshold,
		PkEpoch:        pk.Bytes(),
		TranscriptRoot: root,
		StartHeight:    dkg.StartHeight,
		Slashed:        append([]string(nil), dkg.Slashed...),
		Members:        membersOut,
	}

	if err := m.SetEpoch(ctx, epoch); err != nil {
		return nil, err
	}
	if err := m.SetDKG(ctx, nil); err != nil {
		return nil, err
	}

	events = append(events, sdk.NewEvent(
		dealertypes.EventTypeDealerEpochFinal,
		sdk.NewAttribute("epochId", fmt.Sprintf("%d", epoch.EpochId)),
		sdk.NewAttribute("threshold", fmt.Sprintf("%d", epoch.Threshold)),
		sdk.NewAttribute("committeeSize", fmt.Sprintf("%d", len(epoch.Members))),
		sdk.NewAttribute("transcriptRoot", fmt.Sprintf("%x", root)),
		sdk.NewAttribute("slashed", fmt.Sprintf("%d", len(epoch.Slashed))),
	))

	return events, nil
}

func (m msgServer) finalizeDeck(ctx context.Context, tableID, handID uint64) ([]sdk.Event, error) {
	t, err := m.pokerKeeper.GetTable(ctx, tableID)
	if err != nil {
		return nil, err
	}
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer hand not initialized")
	}
	h := t.Hand
	if h.HandId != handID {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand_id mismatch")
	}
	if h.Phase != pokertypes.HandPhase_HAND_PHASE_SHUFFLE {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand not in shuffle phase")
	}

	dh, err := m.GetHand(ctx, tableID, handID)
	if err != nil {
		return nil, err
	}
	if dh == nil {
		return nil, dealertypes.ErrHandNotFound.Wrap("dealer hand not initialized")
	}
	if dh.Finalized {
		return nil, dealertypes.ErrInvalidRequest.Wrap("deck already finalized")
	}

	epoch, err := m.GetEpoch(ctx)
	if err != nil {
		return nil, err
	}
	if epoch == nil || epoch.EpochId != dh.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch not available")
	}
	qual := epochQualMembers(epoch)
	if len(qual) < int(epoch.Threshold) {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("insufficient qualified members: have %d need %d", len(qual), epoch.Threshold)
	}
	if int(dh.ShuffleStep) != len(qual) {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("deck must be shuffled by all qualified members before finalization: have %d need %d", dh.ShuffleStep, len(qual))
	}

	nowUnix := sdk.UnwrapSDKContext(ctx).BlockTime().Unix()
	to := tableDealerTimeoutSecs(t)

	dh.Finalized = true
	dh.ShuffleDeadline = 0
	dh.HoleSharesDeadline = nowUnix + int64(to)

	// Assign hole card positions deterministically.
	holePos := make([]uint32, 18)
	for i := range holePos {
		holePos[i] = 255
	}
	order := holeDealOrder(t)
	pos := uint32(0)
	for c := 0; c < 2; c++ {
		for _, seatIdx := range order {
			if int(pos) >= len(dh.Deck) {
				break
			}
			holePos[seatIdx*2+c] = pos
			pos++
		}
	}

	meta := h.Dealer
	meta.DeckFinalized = true
	meta.HolePos = holePos
	meta.Cursor = pos
	meta.RevealPos = 255
	meta.RevealDeadline = 0

	if err := m.pokerKeeper.SetTable(ctx, t); err != nil {
		return nil, err
	}
	if err := m.SetHand(ctx, tableID, handID, dh); err != nil {
		return nil, err
	}

	return []sdk.Event{
		sdk.NewEvent(
			dealertypes.EventTypeDeckFinalized,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", tableID)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
		),
	}, nil
}

func (m msgServer) finalizeReveal(ctx context.Context, tableID, handID uint64, pos uint32) ([]sdk.Event, error) {
	t, err := m.pokerKeeper.GetTable(ctx, tableID)
	if err != nil {
		return nil, err
	}
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer hand not initialized")
	}
	h := t.Hand
	if h.HandId != handID {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand_id mismatch")
	}
	meta := h.Dealer
	if meta.RevealPos == 255 || meta.RevealDeadline == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand not awaiting a reveal")
	}
	if pos != meta.RevealPos {
		return nil, dealertypes.ErrInvalidRequest.Wrap("pos not currently revealable")
	}

	dh, err := m.GetHand(ctx, tableID, handID)
	if err != nil {
		return nil, err
	}
	if dh == nil {
		return nil, dealertypes.ErrHandNotFound.Wrap("dealer hand not initialized")
	}
	if int(pos) >= len(dh.Deck) {
		return nil, dealertypes.ErrInvalidRequest.Wrap("pos out of bounds")
	}

	epoch, err := m.GetEpoch(ctx)
	if err != nil {
		return nil, err
	}
	if epoch == nil || epoch.EpochId != dh.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch not available")
	}

	nowUnix := sdk.UnwrapSDKContext(ctx).BlockTime().Unix()
	if nowUnix >= meta.RevealDeadline {
		missing := dealerMissingPubShares(epoch, dh, pos)
		if len(missing) != 0 {
			return nil, dealertypes.ErrInvalidRequest.Wrap("reveal deadline passed; call dealer/timeout")
		}
	}

	for _, r := range dh.Reveals {
		if r.Pos == pos {
			return nil, dealertypes.ErrInvalidRequest.Wrap("pos already revealed")
		}
	}

	type shareRec struct {
		validator string
		index     uint32
		share     ocpcrypto.Point
	}
	shares := make([]shareRec, 0)
	for _, ps := range dh.PubShares {
		if ps.Pos != pos {
			continue
		}
		p, err := ocpcrypto.PointFromBytesCanonical(ps.Share)
		if err != nil {
			return nil, fmt.Errorf("stored share invalid: %w", err)
		}
		shares = append(shares, shareRec{validator: ps.Validator, index: ps.Index, share: p})
	}

	tNeed := int(epoch.Threshold)
	if len(shares) < tNeed {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("insufficient shares: have %d need %d", len(shares), tNeed)
	}

	sort.Slice(shares, func(i, j int) bool {
		if shares[i].index != shares[j].index {
			return shares[i].index < shares[j].index
		}
		return shares[i].validator < shares[j].validator
	})
	shares = shares[:tNeed]

	idxs := make([]uint32, 0, tNeed)
	for _, s := range shares {
		idxs = append(idxs, s.index)
	}
	lambdas, err := ocpcrypto.LagrangeAtZero(idxs)
	if err != nil {
		return nil, err
	}

	combined := ocpcrypto.PointZero()
	for i := 0; i < tNeed; i++ {
		combined = ocpcrypto.PointAdd(combined, ocpcrypto.MulPoint(shares[i].share, lambdas[i]))
	}

	c2, err := ocpcrypto.PointFromBytesCanonical(dh.Deck[pos].C2)
	if err != nil {
		return nil, fmt.Errorf("ciphertext c2 invalid: %w", err)
	}
	pt := ocpcrypto.PointSub(c2, combined)
	cardID, err := pointToCardID(pt, int(dh.DeckSize))
	if err != nil {
		return nil, err
	}

	dh.Reveals = append(dh.Reveals, dealertypes.DealerReveal{Pos: pos, CardId: cardID})
	sort.Slice(dh.Reveals, func(i, j int) bool { return dh.Reveals[i].Pos < dh.Reveals[j].Pos })

	if err := m.SetHand(ctx, tableID, handID, dh); err != nil {
		return nil, err
	}

	pokerEvents, err := m.pokerKeeper.ApplyDealerReveal(ctx, tableID, handID, pos, cardID, nowUnix)
	if err != nil {
		return nil, err
	}

	events := []sdk.Event{
		sdk.NewEvent(
			dealertypes.EventTypeRevealFinalized,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", tableID)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
			sdk.NewAttribute("pos", fmt.Sprintf("%d", pos)),
			sdk.NewAttribute("cardId", fmt.Sprintf("%d", cardID)),
		),
	}
	events = append(events, pokerEvents...)

	// If the hand completed, clean up dealer hand state.
	t2, err := m.pokerKeeper.GetTable(ctx, tableID)
	if err != nil {
		return nil, err
	}
	if t2 == nil || t2.Hand == nil {
		if err := m.SetHand(ctx, tableID, handID, nil); err != nil {
			return nil, err
		}
	}

	return events, nil
}

func (m msgServer) abortHand(ctx context.Context, tableID, handID uint64, reason string) ([]sdk.Event, error) {
	events, err := m.pokerKeeper.AbortHandRefundAllCommits(ctx, tableID, handID, reason)
	if err != nil {
		return nil, err
	}
	if err := m.SetHand(ctx, tableID, handID, nil); err != nil {
		return nil, err
	}
	return events, nil
}

func (m msgServer) timeout(ctx context.Context, tableID, handID uint64) ([]sdk.Event, error) {
	t, err := m.pokerKeeper.GetTable(ctx, tableID)
	if err != nil {
		return nil, err
	}
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("no active dealer hand")
	}
	h := t.Hand
	if h.HandId != handID {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand_id mismatch")
	}

	dh, err := m.GetHand(ctx, tableID, handID)
	if err != nil {
		return nil, err
	}
	if dh == nil {
		return nil, dealertypes.ErrHandNotFound.Wrap("dealer hand not initialized")
	}

	epoch, err := m.GetEpoch(ctx)
	if err != nil {
		return nil, err
	}
	if epoch == nil || epoch.EpochId != dh.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch not available")
	}

	to := tableDealerTimeoutSecs(t)
	if to == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealerTimeoutSecs must be > 0")
	}
	threshold := int(epoch.Threshold)
	if threshold <= 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid epoch threshold")
	}

	params, err := m.GetParams(ctx)
	if err != nil {
		return nil, err
	}
	handSlashFraction := bpsToDec(params.SlashBpsHandDealer)
	handJailDuration := time.Duration(params.JailSecondsHandDealer) * time.Second

	nowUnix := sdk.UnwrapSDKContext(ctx).BlockTime().Unix()

	events := []sdk.Event{
		sdk.NewEvent(
			dealertypes.EventTypeDealerTimeoutDone,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", tableID)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
			sdk.NewAttribute("phase", h.Phase.String()),
		),
	}

	// ---- Shuffle / Finalize ----
	if h.Phase == pokertypes.HandPhase_HAND_PHASE_SHUFFLE && !dh.Finalized {
		if dh.ShuffleDeadline == 0 {
			return nil, dealertypes.ErrInvalidRequest.Wrap("shuffle deadline not initialized")
		}
		if nowUnix < dh.ShuffleDeadline {
			return nil, dealertypes.ErrInvalidRequest.Wrap("shuffle not timed out")
		}

		qual := epochQualMembers(epoch)
		if len(qual) == 0 {
			abortEvents, err := m.abortHand(ctx, tableID, handID, "dealer: no qualified committee members")
			if err != nil {
				return nil, err
			}
			return append(events, abortEvents...), nil
		}

		// If all qualified members already shuffled, allow anyone to finalize deterministically.
		if int(dh.ShuffleStep) == len(qual) {
			deckEvents, err := m.finalizeDeck(ctx, tableID, handID)
			if err != nil {
				return nil, err
			}
			return append(events, deckEvents...), nil
		}
		if int(dh.ShuffleStep) > len(qual) {
			return nil, dealertypes.ErrInvalidRequest.Wrapf("shuffle_step out of range: step=%d qual=%d", dh.ShuffleStep, len(qual))
		}

		// Slash the expected shuffler for the next round (shuffle_step starts at 0).
		expectID := qual[dh.ShuffleStep].Validator
		if epochSlash(epoch, expectID) {
			mem := findEpochMember(epoch, expectID)
			power := int64(0)
			if mem != nil {
				power = mem.Power
			}
			distH := epoch.StartHeight
			if distH == 0 {
				distH = sdk.UnwrapSDKContext(ctx).BlockHeight()
			}
			if err := m.applyPenalty(ctx, expectID, distH, power, handSlashFraction, handJailDuration); err != nil {
				return nil, err
			}
			events = append(events, sdk.NewEvent(
				dealertypes.EventTypeValidatorSlashed,
				sdk.NewAttribute("tableId", fmt.Sprintf("%d", tableID)),
				sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
				sdk.NewAttribute("epochId", fmt.Sprintf("%d", epoch.EpochId)),
				sdk.NewAttribute("validator", expectID),
				sdk.NewAttribute("reason", "shuffle-timeout"),
				sdk.NewAttribute("slashFraction", handSlashFraction.String()),
				sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", distH)),
				sdk.NewAttribute("power", fmt.Sprintf("%d", power)),
			))
		}

		if err := m.SetEpoch(ctx, epoch); err != nil {
			return nil, err
		}

		qual = epochQualMembers(epoch)
		if len(qual) < threshold {
			abortEvents, err := m.abortHand(ctx, tableID, handID, "dealer: committee below threshold after shuffle timeout")
			if err != nil {
				return nil, err
			}
			return append(events, abortEvents...), nil
		}

		// If slashing reduced QUAL enough that all remaining members already shuffled, finalize now.
		if int(dh.ShuffleStep) == len(qual) {
			deckEvents, err := m.finalizeDeck(ctx, tableID, handID)
			if err != nil {
				return nil, err
			}
			return append(events, deckEvents...), nil
		}

		dh.ShuffleDeadline = nowUnix + int64(to)
		if err := m.SetHand(ctx, tableID, handID, dh); err != nil {
			return nil, err
		}
		return events, nil
	}

	// ---- Hole Enc Shares ----
	if h.Phase == pokertypes.HandPhase_HAND_PHASE_SHUFFLE && dh.Finalized {
		if dh.HoleSharesDeadline == 0 {
			return nil, dealertypes.ErrInvalidRequest.Wrap("hole shares deadline not initialized")
		}
		if nowUnix < dh.HoleSharesDeadline {
			return nil, dealertypes.ErrInvalidRequest.Wrap("hole shares not timed out")
		}

		missing, err := dealerMissingHoleEncShares(epoch, t, dh)
		if err != nil {
			return nil, err
		}
		for _, id := range missing {
			if !epochSlash(epoch, id) {
				continue
			}
			mem := findEpochMember(epoch, id)
			power := int64(0)
			if mem != nil {
				power = mem.Power
			}
			distH := epoch.StartHeight
			if distH == 0 {
				distH = sdk.UnwrapSDKContext(ctx).BlockHeight()
			}
			if err := m.applyPenalty(ctx, id, distH, power, handSlashFraction, handJailDuration); err != nil {
				return nil, err
			}
			events = append(events, sdk.NewEvent(
				dealertypes.EventTypeValidatorSlashed,
				sdk.NewAttribute("tableId", fmt.Sprintf("%d", tableID)),
				sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
				sdk.NewAttribute("epochId", fmt.Sprintf("%d", epoch.EpochId)),
				sdk.NewAttribute("validator", id),
				sdk.NewAttribute("reason", "hole-enc-shares-timeout"),
				sdk.NewAttribute("slashFraction", handSlashFraction.String()),
				sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", distH)),
				sdk.NewAttribute("power", fmt.Sprintf("%d", power)),
			))
		}

		if err := m.SetEpoch(ctx, epoch); err != nil {
			return nil, err
		}

		if len(epochQualMembers(epoch)) < threshold {
			abortEvents, err := m.abortHand(ctx, tableID, handID, "dealer: committee below threshold after hole enc shares timeout")
			if err != nil {
				return nil, err
			}
			return append(events, abortEvents...), nil
		}

		ready, err := dealerHoleEncSharesReady(epoch, t, dh)
		if err != nil {
			return nil, err
		}
		if !ready {
			abortEvents, err := m.abortHand(ctx, tableID, handID, "dealer: insufficient hole shares by deadline")
			if err != nil {
				return nil, err
			}
			return append(events, abortEvents...), nil
		}

		// Advance out of shuffle now that shares are ready.
		dh.HoleSharesDeadline = 0
		if err := m.SetHand(ctx, tableID, handID, dh); err != nil {
			return nil, err
		}
		if err := m.pokerKeeper.AdvanceAfterHoleSharesReady(ctx, tableID, handID, nowUnix); err != nil {
			return nil, err
		}

		// Re-load for phase attribute.
		t2, err := m.pokerKeeper.GetTable(ctx, tableID)
		if err != nil {
			return nil, err
		}
		phase := ""
		if t2 != nil && t2.Hand != nil {
			phase = t2.Hand.Phase.String()
		}
		events = append(events, sdk.NewEvent(
			dealertypes.EventTypeHoleCardsReady,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", tableID)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
			sdk.NewAttribute("phase", phase),
		))

		return events, nil
	}

	// ---- Reveal (Board / Showdown) ----
	meta := h.Dealer
	if meta.RevealPos == 255 || meta.RevealDeadline == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("no dealer timeout applicable")
	}
	if nowUnix < meta.RevealDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrap("reveal not timed out")
	}

	pos := meta.RevealPos
	missing := dealerMissingPubShares(epoch, dh, pos)
	for _, id := range missing {
		if !epochSlash(epoch, id) {
			continue
		}
		mem := findEpochMember(epoch, id)
		power := int64(0)
		if mem != nil {
			power = mem.Power
		}
		distH := epoch.StartHeight
		if distH == 0 {
			distH = sdk.UnwrapSDKContext(ctx).BlockHeight()
		}
		if err := m.applyPenalty(ctx, id, distH, power, handSlashFraction, handJailDuration); err != nil {
			return nil, err
		}
		events = append(events, sdk.NewEvent(
			dealertypes.EventTypeValidatorSlashed,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", tableID)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", handID)),
			sdk.NewAttribute("epochId", fmt.Sprintf("%d", epoch.EpochId)),
			sdk.NewAttribute("validator", id),
			sdk.NewAttribute("reason", "reveal-timeout"),
			sdk.NewAttribute("slashFraction", handSlashFraction.String()),
			sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", distH)),
			sdk.NewAttribute("power", fmt.Sprintf("%d", power)),
			sdk.NewAttribute("pos", fmt.Sprintf("%d", pos)),
		))
	}

	if err := m.SetEpoch(ctx, epoch); err != nil {
		return nil, err
	}

	if len(epochQualMembers(epoch)) < threshold {
		abortEvents, err := m.abortHand(ctx, tableID, handID, "dealer: committee below threshold after reveal timeout")
		if err != nil {
			return nil, err
		}
		return append(events, abortEvents...), nil
	}

	revealEvents, err := m.finalizeReveal(ctx, tableID, handID, pos)
	if err != nil {
		return nil, err
	}
	return append(events, revealEvents...), nil
}
