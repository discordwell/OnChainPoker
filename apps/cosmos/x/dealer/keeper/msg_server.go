package keeper

import (
	"bytes"
	"context"
	"fmt"
	"time"

	sdkmath "cosmossdk.io/math"

	sdk "github.com/cosmos/cosmos-sdk/types"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
	pokertypes "onchainpoker/apps/cosmos/x/poker/types"
)

type msgServer struct {
	Keeper
}

var _ dealertypes.MsgServer = msgServer{}

func NewMsgServerImpl(k Keeper) dealertypes.MsgServer {
	return &msgServer{Keeper: k}
}

func (m msgServer) BeginEpoch(ctx context.Context, req *dealertypes.MsgBeginEpoch) (*dealertypes.MsgBeginEpochResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Caller == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing caller")
	}
	if _, err := sdk.AccAddressFromBech32(req.Caller); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid caller address")
	}
	if req.CommitteeSize == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("committee_size must be > 0")
	}
	if req.Threshold == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("threshold must be > 0")
	}
	if req.Threshold > req.CommitteeSize {
		return nil, dealertypes.ErrInvalidRequest.Wrap("threshold exceeds committee_size")
	}

	if cur, err := m.GetDKG(ctx); err != nil {
		return nil, err
	} else if cur != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dkg already in progress")
	}

	next, err := m.GetNextEpochID(ctx)
	if err != nil {
		return nil, err
	}
	epochID := req.EpochId
	if epochID == 0 {
		epochID = next
	}
	if epochID == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch_id must be > 0")
	}
	if epochID != next {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("unexpected epoch_id: expected %d got %d", next, epochID)
	}

	members, randEpoch, err := sampleMembers(ctx, m.committeeStakingKeeper, epochID, req.RandEpoch, int(req.CommitteeSize))
	if err != nil {
		return nil, err
	}

	commitBlocks := req.CommitBlocks
	if commitBlocks == 0 {
		commitBlocks = dkgCommitBlocksDefault
	}
	complaintBlocks := req.ComplaintBlocks
	if complaintBlocks == 0 {
		complaintBlocks = dkgComplaintBlocksDefault
	}
	revealBlocks := req.RevealBlocks
	if revealBlocks == 0 {
		revealBlocks = dkgRevealBlocksDefault
	}
	finalizeBlocks := req.FinalizeBlocks
	if finalizeBlocks == 0 {
		finalizeBlocks = dkgFinalizeBlocksDefault
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	startH := sdkCtx.BlockHeight()
	commitDL := startH + int64(commitBlocks)
	complaintDL := commitDL + int64(complaintBlocks)
	revealDL := complaintDL + int64(revealBlocks)
	finalizeDL := revealDL + int64(finalizeBlocks)

	dkg := &dealertypes.DealerDKG{
		EpochId:           epochID,
		Threshold:         req.Threshold,
		Members:           members,
		StartHeight:       startH,
		CommitDeadline:    commitDL,
		ComplaintDeadline: complaintDL,
		RevealDeadline:    revealDL,
		FinalizeDeadline:  finalizeDL,
		RandEpoch:         append([]byte(nil), randEpoch[:]...),
		Commits:           []dealertypes.DealerDKGCommit{},
		Complaints:        []dealertypes.DealerDKGComplaint{},
		Reveals:           []dealertypes.DealerDKGShareReveal{},
		Slashed:           []string{},
	}

	if err := m.SetDKG(ctx, dkg); err != nil {
		return nil, err
	}
	if err := m.SetNextEpochID(ctx, epochID+1); err != nil {
		return nil, err
	}

	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeDealerEpochBegun,
		sdk.NewAttribute("epochId", fmt.Sprintf("%d", epochID)),
		sdk.NewAttribute("threshold", fmt.Sprintf("%d", req.Threshold)),
		sdk.NewAttribute("committeeSize", fmt.Sprintf("%d", len(members))),
		sdk.NewAttribute("startHeight", fmt.Sprintf("%d", startH)),
		sdk.NewAttribute("commitDeadline", fmt.Sprintf("%d", commitDL)),
		sdk.NewAttribute("complaintDeadline", fmt.Sprintf("%d", complaintDL)),
		sdk.NewAttribute("revealDeadline", fmt.Sprintf("%d", revealDL)),
		sdk.NewAttribute("finalizeDeadline", fmt.Sprintf("%d", finalizeDL)),
	))

	return &dealertypes.MsgBeginEpochResponse{}, nil
}

func (m msgServer) DkgCommit(ctx context.Context, req *dealertypes.MsgDkgCommit) (*dealertypes.MsgDkgCommitResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Dealer == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing dealer")
	}
	if _, err := sdk.ValAddressFromBech32(req.Dealer); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid dealer address")
	}

	dkg, err := m.GetDKG(ctx)
	if err != nil {
		return nil, err
	}
	if dkg == nil {
		return nil, dealertypes.ErrNoDkgInFlight.Wrap("no dkg in progress")
	}
	if req.EpochId != dkg.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch_id mismatch")
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	if sdkCtx.BlockHeight() > dkg.CommitDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrap("commit deadline passed")
	}

	if findDKGMember(dkg, req.Dealer) == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer not in committee")
	}
	if findDKGCommit(dkg, req.Dealer) != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("commit already submitted")
	}
	if len(req.Commitments) != int(dkg.Threshold) {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("commitments length mismatch: expected %d got %d", dkg.Threshold, len(req.Commitments))
	}

	commitments := make([][]byte, 0, len(req.Commitments))
	for i, c := range req.Commitments {
		if len(c) != ocpcrypto.PointBytes {
			return nil, dealertypes.ErrInvalidRequest.Wrapf("commitment[%d] must be 32 bytes", i)
		}
		if _, err := ocpcrypto.PointFromBytesCanonical(c); err != nil {
			return nil, dealertypes.ErrInvalidRequest.Wrapf("commitment[%d] invalid: %v", i, err)
		}
		commitments = append(commitments, append([]byte(nil), c...))
	}

	dkg.Commits = append(dkg.Commits, dealertypes.DealerDKGCommit{
		Dealer:      req.Dealer,
		Commitments: commitments,
	})
	// Deterministic ordering.
	sortDKGCommits(dkg)

	if err := m.SetDKG(ctx, dkg); err != nil {
		return nil, err
	}

	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeDKGCommitAccepted,
		sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
		sdk.NewAttribute("dealer", req.Dealer),
	))
	return &dealertypes.MsgDkgCommitResponse{}, nil
}

func (m msgServer) DkgComplaintMissing(ctx context.Context, req *dealertypes.MsgDkgComplaintMissing) (*dealertypes.MsgDkgComplaintMissingResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Complainer == "" || req.Dealer == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing complainer/dealer")
	}
	if req.Complainer == req.Dealer {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complainer and dealer must differ")
	}
	if _, err := sdk.ValAddressFromBech32(req.Complainer); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid complainer address")
	}
	if _, err := sdk.ValAddressFromBech32(req.Dealer); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid dealer address")
	}

	dkg, err := m.GetDKG(ctx)
	if err != nil {
		return nil, err
	}
	if dkg == nil {
		return nil, dealertypes.ErrNoDkgInFlight.Wrap("no dkg in progress")
	}
	if req.EpochId != dkg.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch_id mismatch")
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	h := sdkCtx.BlockHeight()
	if h < dkg.CommitDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complaints not yet allowed")
	}
	if h > dkg.ComplaintDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complaint deadline passed")
	}

	if findDKGMember(dkg, req.Complainer) == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complainer not in committee")
	}
	if findDKGMember(dkg, req.Dealer) == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer not in committee")
	}
	if findDKGComplaint(dkg, req.Complainer, req.Dealer) != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complaint already filed")
	}

	dkg.Complaints = append(dkg.Complaints, dealertypes.DealerDKGComplaint{
		EpochId:    dkg.EpochId,
		Complainer: req.Complainer,
		Dealer:     req.Dealer,
		Kind:       "missing",
		ShareMsg:   nil,
	})
	sortDKGComplaints(dkg)

	if err := m.SetDKG(ctx, dkg); err != nil {
		return nil, err
	}

	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeDKGComplaintAccepted,
		sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
		sdk.NewAttribute("dealer", req.Dealer),
		sdk.NewAttribute("complainer", req.Complainer),
		sdk.NewAttribute("kind", "missing"),
	))
	return &dealertypes.MsgDkgComplaintMissingResponse{}, nil
}

func (m msgServer) DkgComplaintInvalid(ctx context.Context, req *dealertypes.MsgDkgComplaintInvalid) (*dealertypes.MsgDkgComplaintInvalidResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Complainer == "" || req.Dealer == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing complainer/dealer")
	}
	if req.Complainer == req.Dealer {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complainer and dealer must differ")
	}
	if len(req.ShareMsg) == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing share_msg")
	}
	if _, err := sdk.ValAddressFromBech32(req.Complainer); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid complainer address")
	}
	if _, err := sdk.ValAddressFromBech32(req.Dealer); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid dealer address")
	}

	dkg, err := m.GetDKG(ctx)
	if err != nil {
		return nil, err
	}
	if dkg == nil {
		return nil, dealertypes.ErrNoDkgInFlight.Wrap("no dkg in progress")
	}
	if req.EpochId != dkg.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch_id mismatch")
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	h := sdkCtx.BlockHeight()
	if h < dkg.CommitDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complaints not yet allowed")
	}
	if h > dkg.ComplaintDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complaint deadline passed")
	}

	if findDKGMember(dkg, req.Complainer) == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complainer not in committee")
	}
	dealerMem := findDKGMember(dkg, req.Dealer)
	if dealerMem == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer not in committee")
	}
	if findDKGComplaint(dkg, req.Complainer, req.Dealer) != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complaint already filed")
	}

	shareMsg, err := decodeDKGShareMsgV1(req.ShareMsg)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap(err.Error())
	}
	if shareMsg.EpochID != dkg.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("share_msg epoch_id mismatch")
	}
	if shareMsg.Dealer != req.Dealer {
		return nil, dealertypes.ErrInvalidRequest.Wrap("share_msg dealer mismatch")
	}
	if shareMsg.To != req.Complainer {
		return nil, dealertypes.ErrInvalidRequest.Wrap("share_msg to mismatch")
	}
	if !verifyShareMsgSig(dealerMem.ConsPubkey, shareMsg) {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid share_msg signature")
	}

	// Verify share evidence. If it is objectively invalid, slash immediately.
	commit := findDKGCommit(dkg, req.Dealer)
	toMem := findDKGMember(dkg, req.Complainer)
	if toMem == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("complainer not in committee")
	}

	slashedNow := false
	if commit == nil {
		if dkgSlash(dkg, req.Dealer) {
			slashedNow = true
		}
	} else {
		ok, err := dkgVerifyShare(commit.Commitments, toMem.Index, shareMsg.Share)
		if err != nil {
			return nil, err
		}
		if ok {
			return nil, dealertypes.ErrInvalidRequest.Wrap("share matches commitments")
		}
		if dkgSlash(dkg, req.Dealer) {
			slashedNow = true
		}
	}

	if slashedNow {
		// Apply penalty using the DKG start height + power snapshot.
		if err := m.applyPenalty(ctx, req.Dealer, dkg.StartHeight, dealerMem.Power, bpsToDec(slashBpsDKG), jailDurationDKG); err != nil {
			return nil, err
		}
		sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
			dealertypes.EventTypeValidatorSlashed,
			sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
			sdk.NewAttribute("validator", req.Dealer),
			sdk.NewAttribute("reason", "dkg-invalid-share"),
			sdk.NewAttribute("slashFraction", bpsToDec(slashBpsDKG).String()),
			sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", dkg.StartHeight)),
			sdk.NewAttribute("power", fmt.Sprintf("%d", dealerMem.Power)),
		))
	}

	dkg.Complaints = append(dkg.Complaints, dealertypes.DealerDKGComplaint{
		EpochId:    dkg.EpochId,
		Complainer: req.Complainer,
		Dealer:     req.Dealer,
		Kind:       "invalid",
		ShareMsg:   append([]byte(nil), req.ShareMsg...),
	})
	sortDKGComplaints(dkg)

	if err := m.SetDKG(ctx, dkg); err != nil {
		return nil, err
	}

	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeDKGComplaintAccepted,
		sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
		sdk.NewAttribute("dealer", req.Dealer),
		sdk.NewAttribute("complainer", req.Complainer),
		sdk.NewAttribute("kind", "invalid"),
	))
	return &dealertypes.MsgDkgComplaintInvalidResponse{}, nil
}

func (m msgServer) DkgShareReveal(ctx context.Context, req *dealertypes.MsgDkgShareReveal) (*dealertypes.MsgDkgShareRevealResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Dealer == "" || req.To == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing dealer/to")
	}
	if req.Dealer == req.To {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer and to must differ")
	}
	if _, err := sdk.ValAddressFromBech32(req.Dealer); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid dealer address")
	}
	if _, err := sdk.ValAddressFromBech32(req.To); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid to address")
	}

	dkg, err := m.GetDKG(ctx)
	if err != nil {
		return nil, err
	}
	if dkg == nil {
		return nil, dealertypes.ErrNoDkgInFlight.Wrap("no dkg in progress")
	}
	if req.EpochId != dkg.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch_id mismatch")
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	if sdkCtx.BlockHeight() > dkg.RevealDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrap("reveal deadline passed")
	}

	if findDKGMember(dkg, req.Dealer) == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer not in committee")
	}
	toMem := findDKGMember(dkg, req.To)
	if toMem == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("to not in committee")
	}
	if findDKGComplaint(dkg, req.To, req.Dealer) == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("no complaint for this dealer/to")
	}
	if findDKGReveal(dkg, req.Dealer, req.To) != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("reveal already submitted")
	}

	commit := findDKGCommit(dkg, req.Dealer)
	if commit == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer has not committed")
	}
	ok, err := dkgVerifyShare(commit.Commitments, toMem.Index, req.Share)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, dealertypes.ErrInvalidRequest.Wrap("share does not match commitments")
	}

	dkg.Reveals = append(dkg.Reveals, dealertypes.DealerDKGShareReveal{
		EpochId: dkg.EpochId,
		Dealer:  req.Dealer,
		To:      req.To,
		Share:   append([]byte(nil), req.Share...),
	})
	sortDKGReveals(dkg)

	if err := m.SetDKG(ctx, dkg); err != nil {
		return nil, err
	}

	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeDKGShareRevealed,
		sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
		sdk.NewAttribute("dealer", req.Dealer),
		sdk.NewAttribute("to", req.To),
	))
	return &dealertypes.MsgDkgShareRevealResponse{}, nil
}

func (m msgServer) FinalizeEpoch(ctx context.Context, req *dealertypes.MsgFinalizeEpoch) (*dealertypes.MsgFinalizeEpochResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Caller == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing caller")
	}
	if _, err := sdk.AccAddressFromBech32(req.Caller); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid caller address")
	}

	dkg, err := m.GetDKG(ctx)
	if err != nil {
		return nil, err
	}
	if dkg == nil {
		return nil, dealertypes.ErrNoDkgInFlight.Wrap("no dkg in progress")
	}
	if req.EpochId != dkg.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch_id mismatch")
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	if sdkCtx.BlockHeight() <= dkg.RevealDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("too early to finalize: height=%d revealDeadline=%d", sdkCtx.BlockHeight(), dkg.RevealDeadline)
	}

	events, err := m.finalizeEpoch(ctx, dkg)
	if err != nil {
		return nil, err
	}
	for _, ev := range events {
		sdkCtx.EventManager().EmitEvent(ev)
	}
	return &dealertypes.MsgFinalizeEpochResponse{}, nil
}

func (m msgServer) DkgTimeout(ctx context.Context, req *dealertypes.MsgDkgTimeout) (*dealertypes.MsgDkgTimeoutResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Caller == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing caller")
	}
	if _, err := sdk.AccAddressFromBech32(req.Caller); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid caller address")
	}

	dkg, err := m.GetDKG(ctx)
	if err != nil {
		return nil, err
	}
	if dkg == nil {
		return nil, dealertypes.ErrNoDkgInFlight.Wrap("no dkg in progress")
	}
	if req.EpochId != dkg.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch_id mismatch")
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	if sdkCtx.BlockHeight() <= dkg.CommitDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("too early for dkg timeout: height=%d commitDeadline=%d", sdkCtx.BlockHeight(), dkg.CommitDeadline)
	}

	events := []sdk.Event{
		sdk.NewEvent(
			dealertypes.EventTypeDKGTimeoutApplied,
			sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
			sdk.NewAttribute("height", fmt.Sprintf("%d", sdkCtx.BlockHeight())),
		),
	}

	// Slash missing commits once the commit deadline passes.
	for _, mem := range dkg.Members {
		if findDKGCommit(dkg, mem.Validator) != nil {
			continue
		}
		if dkgIsSlashed(dkg, mem.Validator) {
			continue
		}
		if !dkgSlash(dkg, mem.Validator) {
			continue
		}

		if err := m.applyPenalty(ctx, mem.Validator, dkg.StartHeight, mem.Power, bpsToDec(slashBpsDKG), jailDurationDKG); err != nil {
			return nil, err
		}
		events = append(events, sdk.NewEvent(
			dealertypes.EventTypeValidatorSlashed,
			sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
			sdk.NewAttribute("validator", mem.Validator),
			sdk.NewAttribute("reason", "dkg-commit-timeout"),
			sdk.NewAttribute("slashFraction", bpsToDec(slashBpsDKG).String()),
			sdk.NewAttribute("distributionHeight", fmt.Sprintf("%d", dkg.StartHeight)),
			sdk.NewAttribute("power", fmt.Sprintf("%d", mem.Power)),
		))
	}

	qual := 0
	for _, mem := range dkg.Members {
		if !dkgIsSlashed(dkg, mem.Validator) {
			qual++
		}
	}
	if qual < int(dkg.Threshold) {
		// Abort early if below threshold (liveness).
		if err := m.SetDKG(ctx, nil); err != nil {
			return nil, err
		}
		events = append(events, sdk.NewEvent(
			dealertypes.EventTypeDealerEpochAborted,
			sdk.NewAttribute("epochId", fmt.Sprintf("%d", dkg.EpochId)),
			sdk.NewAttribute("threshold", fmt.Sprintf("%d", dkg.Threshold)),
			sdk.NewAttribute("qual", fmt.Sprintf("%d", qual)),
			sdk.NewAttribute("reason", "dkg-below-threshold"),
		))
		for _, ev := range events {
			sdkCtx.EventManager().EmitEvent(ev)
		}
		return &dealertypes.MsgDkgTimeoutResponse{}, nil
	}

	// Persist any slashing state changes.
	if err := m.SetDKG(ctx, dkg); err != nil {
		return nil, err
	}

	// If the reveal deadline passed, finalize deterministically.
	if sdkCtx.BlockHeight() > dkg.RevealDeadline {
		finalEvents, err := m.finalizeEpoch(ctx, dkg)
		if err != nil {
			return nil, err
		}
		events = append(events, finalEvents...)
	}

	for _, ev := range events {
		sdkCtx.EventManager().EmitEvent(ev)
	}
	return &dealertypes.MsgDkgTimeoutResponse{}, nil
}

func (m msgServer) InitHand(ctx context.Context, req *dealertypes.MsgInitHand) (*dealertypes.MsgInitHandResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Caller == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing caller")
	}
	if _, err := sdk.AccAddressFromBech32(req.Caller); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid caller address")
	}
	if req.TableId == 0 || req.HandId == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("table_id and hand_id must be > 0")
	}

	t, err := m.pokerKeeper.GetTable(ctx, req.TableId)
	if err != nil {
		return nil, err
	}
	if t == nil || t.Hand == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("no active hand")
	}
	h := t.Hand
	if h.HandId != req.HandId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand_id mismatch")
	}
	if h.Phase != pokertypes.HandPhase_HAND_PHASE_SHUFFLE {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand not in shuffle phase")
	}
	if h.Dealer == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand missing dealer meta")
	}

	if existing, err := m.GetHand(ctx, req.TableId, req.HandId); err != nil {
		return nil, err
	} else if existing != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer hand already initialized")
	}

	epoch, err := m.GetEpoch(ctx)
	if err != nil {
		return nil, err
	}
	if epoch == nil {
		return nil, dealertypes.ErrNoActiveEpoch.Wrap("no active dealer epoch")
	}
	if epoch.EpochId != req.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("epoch_id mismatch: expected %d got %d", epoch.EpochId, req.EpochId)
	}

	deckSize := req.DeckSize
	if deckSize == 0 {
		deckSize = 52
	}
	if deckSize < 2 || deckSize > 52 {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("invalid deck_size %d", deckSize)
	}

	k, err := deriveHandScalar(epoch.EpochId, t.Id, h.HandId)
	if err != nil {
		return nil, err
	}

	pkEpoch, err := ocpcrypto.PointFromBytesCanonical(epoch.PkEpoch)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("pk_epoch invalid: %v", err)
	}
	pkHand := ocpcrypto.MulPoint(pkEpoch, k)

	kBytes := k.Bytes()
	deck := make([]dealertypes.DealerCiphertext, 0, deckSize)
	for i := 0; i < int(deckSize); i++ {
		mpt := cardPoint(i)
		r, err := hashToNonzeroScalar(deckInitDomain, kBytes, u16le(uint16(i)))
		if err != nil {
			return nil, err
		}
		ct, err := ocpcrypto.ElGamalEncrypt(pkHand, mpt, r)
		if err != nil {
			return nil, err
		}
		deck = append(deck, dealertypes.DealerCiphertext{
			C1: append([]byte(nil), ct.C1.Bytes()...),
			C2: append([]byte(nil), ct.C2.Bytes()...),
		})
	}

	nowUnix := sdk.UnwrapSDKContext(ctx).BlockTime().Unix()
	to := tableDealerTimeoutSecs(t)

	dh := &dealertypes.DealerHand{
		EpochId:            epoch.EpochId,
		PkHand:             append([]byte(nil), pkHand.Bytes()...),
		DeckSize:           deckSize,
		Deck:               deck,
		ShuffleStep:        0,
		Finalized:          false,
		ShuffleDeadline:    nowUnix + int64(to),
		HoleSharesDeadline: 0,
		PubShares:          []dealertypes.DealerPubShare{},
		EncShares:          []dealertypes.DealerEncShare{},
		Reveals:            []dealertypes.DealerReveal{},
	}

	// Update poker meta.
	meta := h.Dealer
	meta.EpochId = epoch.EpochId
	meta.DeckSize = deckSize
	meta.DeckFinalized = false
	meta.Cursor = 0
	meta.RevealPos = 255
	meta.RevealDeadline = 0
	meta.HolePos = make([]uint32, 18)
	for i := range meta.HolePos {
		meta.HolePos[i] = 255
	}

	if err := m.pokerKeeper.SetTable(ctx, t); err != nil {
		return nil, err
	}
	if err := m.SetHand(ctx, req.TableId, req.HandId, dh); err != nil {
		return nil, err
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeDealerHandInitialized,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", req.HandId)),
		sdk.NewAttribute("epochId", fmt.Sprintf("%d", epoch.EpochId)),
		sdk.NewAttribute("deckSize", fmt.Sprintf("%d", deckSize)),
	))
	return &dealertypes.MsgInitHandResponse{}, nil
}

func (m msgServer) SubmitShuffle(ctx context.Context, req *dealertypes.MsgSubmitShuffle) (*dealertypes.MsgSubmitShuffleResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Shuffler == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing shuffler")
	}
	if _, err := sdk.ValAddressFromBech32(req.Shuffler); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid shuffler address")
	}
	if req.TableId == 0 || req.HandId == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("table_id and hand_id must be > 0")
	}
	if len(req.ProofShuffle) == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing proof_shuffle")
	}

	t, err := m.pokerKeeper.GetTable(ctx, req.TableId)
	if err != nil {
		return nil, err
	}
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer hand not initialized")
	}
	h := t.Hand
	if h.HandId != req.HandId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand_id mismatch")
	}
	if h.Phase != pokertypes.HandPhase_HAND_PHASE_SHUFFLE {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand not in shuffle phase")
	}

	dh, err := m.GetHand(ctx, req.TableId, req.HandId)
	if err != nil {
		return nil, err
	}
	if dh == nil {
		return nil, dealertypes.ErrHandNotFound.Wrap("dealer hand not initialized")
	}

	nowUnix := sdk.UnwrapSDKContext(ctx).BlockTime().Unix()
	if dh.ShuffleDeadline != 0 && nowUnix >= dh.ShuffleDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrap("shuffle deadline passed; call dealer/timeout")
	}
	if dh.Finalized {
		return nil, dealertypes.ErrInvalidRequest.Wrap("deck already finalized")
	}
	if req.Round != dh.ShuffleStep+1 {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("round mismatch: expected %d got %d", dh.ShuffleStep+1, req.Round)
	}

	epoch, err := m.GetEpoch(ctx)
	if err != nil {
		return nil, err
	}
	if epoch == nil || epoch.EpochId != dh.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch not available")
	}
	if findEpochMember(epoch, req.Shuffler) == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("shuffler not in committee")
	}
	if epochIsSlashed(epoch, req.Shuffler) {
		return nil, dealertypes.ErrInvalidRequest.Wrap("shuffler is slashed")
	}

	qual := epochQualMembers(epoch)
	if int(dh.ShuffleStep) >= len(qual) {
		return nil, dealertypes.ErrInvalidRequest.Wrap("no qualified shuffler available")
	}
	expectID := qual[dh.ShuffleStep].Validator
	if req.Shuffler != expectID {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("unexpected shuffler: expected %s got %s", expectID, req.Shuffler)
	}

	deckOut, proofHash, err := verifyShuffle(dh.PkHand, dh.Deck, req.ProofShuffle)
	if err != nil {
		return nil, err
	}

	dh.Deck = deckOut
	dh.ShuffleStep = req.Round
	dh.ShuffleDeadline = nowUnix + int64(tableDealerTimeoutSecs(t))

	if err := m.SetHand(ctx, req.TableId, req.HandId, dh); err != nil {
		return nil, err
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeShuffleAccepted,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", req.HandId)),
		sdk.NewAttribute("round", fmt.Sprintf("%d", req.Round)),
		sdk.NewAttribute("shuffler", req.Shuffler),
		sdk.NewAttribute("proofHash", proofHash),
	))
	return &dealertypes.MsgSubmitShuffleResponse{}, nil
}

func (m msgServer) FinalizeDeck(ctx context.Context, req *dealertypes.MsgFinalizeDeck) (*dealertypes.MsgFinalizeDeckResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Caller == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing caller")
	}
	if _, err := sdk.AccAddressFromBech32(req.Caller); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid caller address")
	}
	if req.TableId == 0 || req.HandId == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("table_id and hand_id must be > 0")
	}

	events, err := m.finalizeDeck(ctx, req.TableId, req.HandId)
	if err != nil {
		return nil, err
	}
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	for _, ev := range events {
		sdkCtx.EventManager().EmitEvent(ev)
	}
	return &dealertypes.MsgFinalizeDeckResponse{}, nil
}

func (m msgServer) SubmitEncShare(ctx context.Context, req *dealertypes.MsgSubmitEncShare) (*dealertypes.MsgSubmitEncShareResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Validator == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing validator")
	}
	if _, err := sdk.ValAddressFromBech32(req.Validator); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid validator address")
	}
	if req.TableId == 0 || req.HandId == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("table_id and hand_id must be > 0")
	}
	if len(req.PkPlayer) != ocpcrypto.PointBytes {
		return nil, dealertypes.ErrInvalidRequest.Wrap("pk_player must be 32 bytes")
	}
	if len(req.EncShare) != 64 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("enc_share must be 64 bytes")
	}
	if len(req.ProofEncShare) != 160 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("proof_enc_share must be 160 bytes")
	}

	t, err := m.pokerKeeper.GetTable(ctx, req.TableId)
	if err != nil {
		return nil, err
	}
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer hand not initialized")
	}
	h := t.Hand
	if h.HandId != req.HandId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand_id mismatch")
	}
	if h.Phase != pokertypes.HandPhase_HAND_PHASE_SHUFFLE {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand not in shuffle phase")
	}
	meta := h.Dealer
	if !meta.DeckFinalized || len(meta.HolePos) != 18 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("deck not finalized")
	}

	dh, err := m.GetHand(ctx, req.TableId, req.HandId)
	if err != nil {
		return nil, err
	}
	if dh == nil {
		return nil, dealertypes.ErrHandNotFound.Wrap("dealer hand not initialized")
	}
	if !dh.Finalized {
		return nil, dealertypes.ErrInvalidRequest.Wrap("deck not finalized")
	}
	if int(req.Pos) >= len(dh.Deck) {
		return nil, dealertypes.ErrInvalidRequest.Wrap("pos out of bounds")
	}

	nowUnix := sdk.UnwrapSDKContext(ctx).BlockTime().Unix()
	if dh.HoleSharesDeadline == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hole shares deadline not initialized")
	}
	if nowUnix >= dh.HoleSharesDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hole shares deadline passed; call dealer/timeout")
	}

	epoch, err := m.GetEpoch(ctx)
	if err != nil {
		return nil, err
	}
	if epoch == nil || epoch.EpochId != dh.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch not available")
	}
	mem := findEpochMember(epoch, req.Validator)
	if mem == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("validator not in committee")
	}
	if epochIsSlashed(epoch, req.Validator) {
		return nil, dealertypes.ErrInvalidRequest.Wrap("validator is slashed")
	}

	// Gate: only allow encrypted shares for in-hand hole positions, and require pk match.
	holeSeat, ok := isHolePos(meta, h, req.Pos)
	if !ok {
		return nil, dealertypes.ErrInvalidRequest.Wrap("pos is not a hole card position")
	}
	if holeSeat < 0 || holeSeat >= 9 || t.Seats[holeSeat] == nil || len(t.Seats[holeSeat].Pk) != ocpcrypto.PointBytes {
		return nil, dealertypes.ErrInvalidRequest.Wrap("seat missing pk")
	}
	if !bytes.Equal(t.Seats[holeSeat].Pk, req.PkPlayer) {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("pk_player mismatch for seat %d", holeSeat)
	}

	// Prevent duplicates.
	for _, es := range dh.EncShares {
		if es.Pos == req.Pos && es.Validator == req.Validator {
			return nil, dealertypes.ErrInvalidRequest.Wrap("duplicate enc share")
		}
	}

	k, err := deriveHandScalar(dh.EpochId, t.Id, h.HandId)
	if err != nil {
		return nil, err
	}
	Yepoch, err := ocpcrypto.PointFromBytesCanonical(mem.PubShare)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("pub_share invalid: %v", err)
	}
	Yhand := ocpcrypto.MulPoint(Yepoch, k)

	c1Cipher, err := ocpcrypto.PointFromBytesCanonical(dh.Deck[req.Pos].C1)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("ciphertext c1 invalid: %v", err)
	}
	pkPlayer, err := ocpcrypto.PointFromBytesCanonical(req.PkPlayer)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("pk_player invalid: %v", err)
	}
	U, err := ocpcrypto.PointFromBytesCanonical(req.EncShare[:32])
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("enc_share.u invalid: %v", err)
	}
	V, err := ocpcrypto.PointFromBytesCanonical(req.EncShare[32:])
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("enc_share.v invalid: %v", err)
	}
	proof, err := ocpcrypto.DecodeEncShareProof(req.ProofEncShare)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("proof_enc_share invalid: %v", err)
	}
	okProof, err := ocpcrypto.EncShareVerify(Yhand, c1Cipher, pkPlayer, U, V, proof)
	if err != nil {
		return nil, err
	}
	if !okProof {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid enc share proof")
	}

	dh.EncShares = append(dh.EncShares, dealertypes.DealerEncShare{
		Pos:       req.Pos,
		Validator: req.Validator,
		Index:     mem.Index,
		PkPlayer:  append([]byte(nil), req.PkPlayer...),
		EncShare:  append([]byte(nil), req.EncShare...),
		Proof:     append([]byte(nil), req.ProofEncShare...),
	})
	sortEncShares(dh)

	// If we have enough encrypted shares for all in-hand hole cards, open betting.
	if ready, err := dealerHoleEncSharesReady(epoch, t, dh); err != nil {
		return nil, err
	} else if ready && h.Phase == pokertypes.HandPhase_HAND_PHASE_SHUFFLE {
		dh.HoleSharesDeadline = 0
		if err := m.SetHand(ctx, req.TableId, req.HandId, dh); err != nil {
			return nil, err
		}
		if err := m.pokerKeeper.AdvanceAfterHoleSharesReady(ctx, req.TableId, req.HandId, nowUnix); err != nil {
			return nil, err
		}

		// Re-load for event attributes.
		t2, err := m.pokerKeeper.GetTable(ctx, req.TableId)
		if err != nil {
			return nil, err
		}
		phase := ""
		if t2 != nil && t2.Hand != nil {
			phase = t2.Hand.Phase.String()
		}
		sdk.UnwrapSDKContext(ctx).EventManager().EmitEvent(sdk.NewEvent(
			dealertypes.EventTypeHoleCardsReady,
			sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
			sdk.NewAttribute("handId", fmt.Sprintf("%d", req.HandId)),
			sdk.NewAttribute("phase", phase),
		))
	}

	if err := m.SetHand(ctx, req.TableId, req.HandId, dh); err != nil {
		return nil, err
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypeEncShareAccepted,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", req.HandId)),
		sdk.NewAttribute("pos", fmt.Sprintf("%d", req.Pos)),
		sdk.NewAttribute("validator", req.Validator),
	))
	return &dealertypes.MsgSubmitEncShareResponse{}, nil
}

func (m msgServer) SubmitPubShare(ctx context.Context, req *dealertypes.MsgSubmitPubShare) (*dealertypes.MsgSubmitPubShareResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Validator == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing validator")
	}
	if _, err := sdk.ValAddressFromBech32(req.Validator); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid validator address")
	}
	if req.TableId == 0 || req.HandId == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("table_id and hand_id must be > 0")
	}
	if len(req.PubShare) == 0 || len(req.ProofShare) == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing pub_share/proof_share")
	}

	t, err := m.pokerKeeper.GetTable(ctx, req.TableId)
	if err != nil {
		return nil, err
	}
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("dealer hand not initialized")
	}
	h := t.Hand
	if h.HandId != req.HandId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand_id mismatch")
	}
	meta := h.Dealer
	if meta.RevealPos == 255 || meta.RevealDeadline == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("hand not awaiting a reveal")
	}
	if req.Pos != meta.RevealPos {
		return nil, dealertypes.ErrInvalidRequest.Wrap("pos not currently revealable")
	}

	nowUnix := sdk.UnwrapSDKContext(ctx).BlockTime().Unix()
	if nowUnix >= meta.RevealDeadline {
		return nil, dealertypes.ErrInvalidRequest.Wrap("reveal deadline passed; call dealer/timeout")
	}

	dh, err := m.GetHand(ctx, req.TableId, req.HandId)
	if err != nil {
		return nil, err
	}
	if dh == nil {
		return nil, dealertypes.ErrHandNotFound.Wrap("dealer hand not initialized")
	}
	if int(req.Pos) >= len(dh.Deck) {
		return nil, dealertypes.ErrInvalidRequest.Wrap("pos out of bounds")
	}

	epoch, err := m.GetEpoch(ctx)
	if err != nil {
		return nil, err
	}
	if epoch == nil || epoch.EpochId != dh.EpochId {
		return nil, dealertypes.ErrInvalidRequest.Wrap("epoch not available")
	}
	mem := findEpochMember(epoch, req.Validator)
	if mem == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("validator not in committee")
	}
	if epochIsSlashed(epoch, req.Validator) {
		return nil, dealertypes.ErrInvalidRequest.Wrap("validator is slashed")
	}

	// Prevent duplicates.
	for _, ps := range dh.PubShares {
		if ps.Pos == req.Pos && ps.Validator == req.Validator {
			return nil, dealertypes.ErrInvalidRequest.Wrap("duplicate pub share")
		}
	}

	k, err := deriveHandScalar(dh.EpochId, t.Id, h.HandId)
	if err != nil {
		return nil, err
	}
	Yepoch, err := ocpcrypto.PointFromBytesCanonical(mem.PubShare)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("pub_share invalid: %v", err)
	}
	Yhand := ocpcrypto.MulPoint(Yepoch, k)

	c1, err := ocpcrypto.PointFromBytesCanonical(dh.Deck[req.Pos].C1)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("ciphertext c1 invalid: %v", err)
	}
	share, err := ocpcrypto.PointFromBytesCanonical(req.PubShare)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("pub_share invalid: %v", err)
	}
	proof, err := ocpcrypto.DecodeChaumPedersenProof(req.ProofShare)
	if err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrapf("proof_share invalid: %v", err)
	}
	okProof, err := ocpcrypto.ChaumPedersenVerify(Yhand, c1, share, proof)
	if err != nil {
		return nil, err
	}
	if !okProof {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid pub share proof")
	}

	dh.PubShares = append(dh.PubShares, dealertypes.DealerPubShare{
		Pos:       req.Pos,
		Validator: req.Validator,
		Index:     mem.Index,
		Share:     append([]byte(nil), req.PubShare...),
		Proof:     append([]byte(nil), req.ProofShare...),
	})
	sortPubShares(dh)

	if err := m.SetHand(ctx, req.TableId, req.HandId, dh); err != nil {
		return nil, err
	}

	sdkCtx := sdk.UnwrapSDKContext(ctx)
	sdkCtx.EventManager().EmitEvent(sdk.NewEvent(
		dealertypes.EventTypePubShareAccepted,
		sdk.NewAttribute("tableId", fmt.Sprintf("%d", req.TableId)),
		sdk.NewAttribute("handId", fmt.Sprintf("%d", req.HandId)),
		sdk.NewAttribute("pos", fmt.Sprintf("%d", req.Pos)),
		sdk.NewAttribute("validator", req.Validator),
	))
	return &dealertypes.MsgSubmitPubShareResponse{}, nil
}

func (m msgServer) FinalizeReveal(ctx context.Context, req *dealertypes.MsgFinalizeReveal) (*dealertypes.MsgFinalizeRevealResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Caller == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing caller")
	}
	if _, err := sdk.AccAddressFromBech32(req.Caller); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid caller address")
	}
	if req.TableId == 0 || req.HandId == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("table_id and hand_id must be > 0")
	}

	events, err := m.finalizeReveal(ctx, req.TableId, req.HandId, req.Pos)
	if err != nil {
		return nil, err
	}
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	for _, ev := range events {
		sdkCtx.EventManager().EmitEvent(ev)
	}
	return &dealertypes.MsgFinalizeRevealResponse{}, nil
}

func (m msgServer) Timeout(ctx context.Context, req *dealertypes.MsgTimeout) (*dealertypes.MsgTimeoutResponse, error) {
	if req == nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("nil request")
	}
	if req.Caller == "" {
		return nil, dealertypes.ErrInvalidRequest.Wrap("missing caller")
	}
	if _, err := sdk.AccAddressFromBech32(req.Caller); err != nil {
		return nil, dealertypes.ErrInvalidRequest.Wrap("invalid caller address")
	}
	if req.TableId == 0 || req.HandId == 0 {
		return nil, dealertypes.ErrInvalidRequest.Wrap("table_id and hand_id must be > 0")
	}

	events, err := m.timeout(ctx, req.TableId, req.HandId)
	if err != nil {
		return nil, err
	}
	sdkCtx := sdk.UnwrapSDKContext(ctx)
	for _, ev := range events {
		sdkCtx.EventManager().EmitEvent(ev)
	}
	return &dealertypes.MsgTimeoutResponse{}, nil
}

// applyPenalty is a thin wrapper around the shared slashing helper.
func (m msgServer) applyPenalty(
	ctx context.Context,
	valoper string,
	distributionHeight int64,
	powerAtDistributionHeight int64,
	slashFraction sdkmath.LegacyDec,
	jailDuration time.Duration,
) error {
	valAddr, err := sdk.ValAddressFromBech32(valoper)
	if err != nil {
		return err
	}
	return SlashAndJailValidator(
		ctx,
		m.stakingKeeper,
		m.slashingKeeper,
		valAddr,
		distributionHeight,
		powerAtDistributionHeight,
		slashFraction,
		jailDuration,
	)
}
