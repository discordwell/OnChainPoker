package app

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	abci "github.com/cometbft/cometbft/abci/types"

	"onchainpoker/apps/chain/internal/codec"
	"onchainpoker/apps/chain/internal/ocpcrypto"
	"onchainpoker/apps/chain/internal/ocpshuffle"
	"onchainpoker/apps/chain/internal/state"
)

const (
	handDeriveDomain = "ocp/v1/dealer/hand-derive"
	deckInitDomain   = "ocp/v1/dealer/deck-init"

	dkgRandDomain       = "ocp/v1/dkg/rand"
	dkgCommitteeDomain  = "ocp/v1/dkg/committee"
	dkgTranscriptDomain = "ocp/v1/dkg/transcript"

	// v0 localnet defaults (measured in blocks).
	dkgCommitBlocksDefault    uint64 = 5
	dkgComplaintBlocksDefault uint64 = 5
	dkgRevealBlocksDefault    uint64 = 5
	dkgFinalizeBlocksDefault  uint64 = 5
)

func u64le(x uint64) []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, x)
	return b
}

func u16le(x uint16) []byte {
	b := make([]byte, 2)
	binary.LittleEndian.PutUint16(b, x)
	return b
}

func deriveHandScalar(epochID, tableID, handID uint64) (ocpcrypto.Scalar, error) {
	return ocpcrypto.HashToScalar(handDeriveDomain, u64le(epochID), u64le(tableID), u64le(handID))
}

func hashToNonzeroScalar(domain string, msgs ...[]byte) (ocpcrypto.Scalar, error) {
	for counter := uint32(0); counter < 256; counter++ {
		var extra []byte
		if counter == 0 {
			extra = nil
		} else {
			extra = []byte{byte(counter)}
		}
		all := msgs
		if extra != nil {
			all = append(append([][]byte(nil), msgs...), extra)
		}
		s, err := ocpcrypto.HashToScalar(domain, all...)
		if err != nil {
			return ocpcrypto.Scalar{}, err
		}
		if !s.IsZero() {
			return s, nil
		}
	}
	return ocpcrypto.Scalar{}, fmt.Errorf("hashToNonzeroScalar: failed to find non-zero scalar")
}

func cardPoint(cardID int) ocpcrypto.Point {
	// Deterministic collision-free mapping for 0..51:
	//   M_c = (c+1)*G
	return ocpcrypto.MulBase(ocpcrypto.ScalarFromUint64(uint64(cardID + 1)))
}

func pointToCardID(p ocpcrypto.Point, deckSize int) (uint8, error) {
	if deckSize <= 0 || deckSize > 52 {
		deckSize = 52
	}
	for c := 0; c < deckSize; c++ {
		if ocpcrypto.PointEq(p, cardPoint(c)) {
			return uint8(c), nil
		}
	}
	return 0, fmt.Errorf("plaintext does not map to a known card id")
}

func dealerBeginEpoch(st *state.State, msg codec.DealerBeginEpochTx) (*abci.ExecTxResult, error) {
	if st == nil {
		return nil, fmt.Errorf("state is nil")
	}
	if st.Dealer == nil {
		st.Dealer = &state.DealerState{NextEpochID: 1}
	}
	if st.Dealer.DKG != nil {
		return nil, fmt.Errorf("dkg already in progress")
	}
	if msg.CommitteeSize == 0 {
		return nil, fmt.Errorf("committeeSize must be > 0")
	}
	if msg.Threshold == 0 {
		return nil, fmt.Errorf("threshold must be > 0")
	}
	if int(msg.Threshold) > int(msg.CommitteeSize) {
		return nil, fmt.Errorf("threshold exceeds committeeSize")
	}

	epochID := msg.EpochID
	if epochID == 0 {
		epochID = st.Dealer.NextEpochID
	}
	if epochID == 0 {
		return nil, fmt.Errorf("epochId must be > 0")
	}
	if epochID != st.Dealer.NextEpochID {
		return nil, fmt.Errorf("unexpected epochId: expected %d got %d", st.Dealer.NextEpochID, epochID)
	}

	// Active validator ids are used as the sampling pool.
	active := make([]string, 0, len(st.Dealer.Validators))
	for _, v := range st.Dealer.Validators {
		if v.ValidatorID == "" {
			continue
		}
		if v.Status != "" && v.Status != state.ValidatorActive {
			continue
		}
		// v0 staking: require an on-chain pubkey and a non-zero bond to be eligible for committee sampling.
		if len(v.PubKey) != ed25519.PublicKeySize {
			continue
		}
		if v.Bond == 0 {
			continue
		}
		if v.Status == "" || v.Status == state.ValidatorActive {
			active = append(active, v.ValidatorID)
		}
	}
	sort.Strings(active)
	if len(active) < int(msg.CommitteeSize) {
		return nil, fmt.Errorf("not enough active validators: have %d need %d", len(active), msg.CommitteeSize)
	}

	// v0 randomness beacon: allow an explicit randEpoch, else derive from (height, epochId).
	randEpoch := msg.RandEpoch
	if len(randEpoch) != 0 && len(randEpoch) != 32 {
		return nil, fmt.Errorf("randEpoch must be 32 bytes (or omitted)")
	}
	if len(randEpoch) == 0 {
		sum := sha256.Sum256(append(append([]byte(dkgRandDomain), u64le(epochID)...), u64le(uint64(st.Height))...))
		randEpoch = sum[:]
	}

	seed := sha256.Sum256(append(append([]byte(dkgCommitteeDomain), randEpoch...), u64le(epochID)...))
	shuffled := deterministicShuffleStrings(active, seed[:])
	selected := append([]string(nil), shuffled[:msg.CommitteeSize]...)
	sort.Strings(selected)

	members := make([]state.DealerMember, 0, len(selected))
	for i, id := range selected {
		members = append(members, state.DealerMember{
			ValidatorID: id,
			Index:       uint32(i + 1), // 1..N
			PubShare:    nil,           // computed on finalize
		})
	}

	commitBlocks := msg.CommitBlocks
	if commitBlocks == 0 {
		commitBlocks = dkgCommitBlocksDefault
	}
	complaintBlocks := msg.ComplaintBlocks
	if complaintBlocks == 0 {
		complaintBlocks = dkgComplaintBlocksDefault
	}
	revealBlocks := msg.RevealBlocks
	if revealBlocks == 0 {
		revealBlocks = dkgRevealBlocksDefault
	}
	finalizeBlocks := msg.FinalizeBlocks
	if finalizeBlocks == 0 {
		finalizeBlocks = dkgFinalizeBlocksDefault
	}

	startH := st.Height
	commitDL, err := addInt64AndU64Checked(startH, commitBlocks, "dkg commit deadline")
	if err != nil {
		return nil, err
	}
	complaintDL, err := addInt64AndU64Checked(commitDL, complaintBlocks, "dkg complaint deadline")
	if err != nil {
		return nil, err
	}
	revealDL, err := addInt64AndU64Checked(complaintDL, revealBlocks, "dkg reveal deadline")
	if err != nil {
		return nil, err
	}
	finalizeDL, err := addInt64AndU64Checked(revealDL, finalizeBlocks, "dkg finalize deadline")
	if err != nil {
		return nil, err
	}

	st.Dealer.DKG = &state.DealerDKG{
		EpochID:           epochID,
		Threshold:         msg.Threshold,
		Members:           members,
		StartHeight:       startH,
		CommitDeadline:    commitDL,
		ComplaintDeadline: complaintDL,
		RevealDeadline:    revealDL,
		FinalizeDeadline:  finalizeDL,
		RandEpoch:         append([]byte(nil), randEpoch...),
	}
	st.Dealer.NextEpochID = epochID + 1

	ev := okEvent("DealerEpochBegun", map[string]string{
		"epochId":           fmt.Sprintf("%d", epochID),
		"threshold":         fmt.Sprintf("%d", msg.Threshold),
		"committeeSize":     fmt.Sprintf("%d", len(members)),
		"startHeight":       fmt.Sprintf("%d", startH),
		"commitDeadline":    fmt.Sprintf("%d", commitDL),
		"complaintDeadline": fmt.Sprintf("%d", complaintDL),
		"revealDeadline":    fmt.Sprintf("%d", revealDL),
		"finalizeDeadline":  fmt.Sprintf("%d", finalizeDL),
	})
	return ev, nil
}

func deterministicShuffleStrings(in []string, seed []byte) []string {
	out := append([]string(nil), in...)
	var counter uint64
	for i := len(out) - 1; i > 0; i-- {
		buf := make([]byte, len(seed)+8)
		copy(buf, seed)
		binary.LittleEndian.PutUint64(buf[len(seed):], counter)
		h := sha256.Sum256(buf)
		counter++
		j := int(binary.LittleEndian.Uint64(h[:8]) % uint64(i+1))
		out[i], out[j] = out[j], out[i]
	}
	return out
}

func findDKGMember(dkg *state.DealerDKG, validatorID string) *state.DealerMember {
	if dkg == nil {
		return nil
	}
	for i := range dkg.Members {
		if dkg.Members[i].ValidatorID == validatorID {
			return &dkg.Members[i]
		}
	}
	return nil
}

func findDKGCommit(dkg *state.DealerDKG, dealerID string) *state.DealerDKGCommit {
	if dkg == nil {
		return nil
	}
	for i := range dkg.Commits {
		if dkg.Commits[i].DealerID == dealerID {
			return &dkg.Commits[i]
		}
	}
	return nil
}

func findDKGComplaint(dkg *state.DealerDKG, complainerID, dealerID string) *state.DealerDKGComplaint {
	if dkg == nil {
		return nil
	}
	for i := range dkg.Complaints {
		c := &dkg.Complaints[i]
		if c.ComplainerID == complainerID && c.DealerID == dealerID {
			return c
		}
	}
	return nil
}

func findDKGReveal(dkg *state.DealerDKG, dealerID, toID string) *state.DealerDKGShareReveal {
	if dkg == nil {
		return nil
	}
	for i := range dkg.Reveals {
		r := &dkg.Reveals[i]
		if r.DealerID == dealerID && r.ToID == toID {
			return r
		}
	}
	return nil
}

func dkgIsSlashed(dkg *state.DealerDKG, validatorID string) bool {
	if dkg == nil {
		return false
	}
	for _, id := range dkg.Slashed {
		if id == validatorID {
			return true
		}
	}
	return false
}

func dkgSlash(dkg *state.DealerDKG, validatorID string) {
	if dkg == nil || validatorID == "" {
		return
	}
	if dkgIsSlashed(dkg, validatorID) {
		return
	}
	dkg.Slashed = append(dkg.Slashed, validatorID)
	sort.Strings(dkg.Slashed)
}

func dkgIsPenalized(dkg *state.DealerDKG, validatorID string) bool {
	if dkg == nil {
		return false
	}
	for _, id := range dkg.Penalized {
		if id == validatorID {
			return true
		}
	}
	return false
}

func dkgMarkPenalized(dkg *state.DealerDKG, validatorID string) {
	if dkg == nil || validatorID == "" {
		return
	}
	if dkgIsPenalized(dkg, validatorID) {
		return
	}
	dkg.Penalized = append(dkg.Penalized, validatorID)
	sort.Strings(dkg.Penalized)
}

func dealerDKGCommit(st *state.State, msg codec.DealerDKGCommitTx) (*abci.ExecTxResult, error) {
	if st == nil || st.Dealer == nil || st.Dealer.DKG == nil {
		return nil, fmt.Errorf("no dkg in progress")
	}
	dkg := st.Dealer.DKG
	if msg.EpochID != dkg.EpochID {
		return nil, fmt.Errorf("epochId mismatch: expected %d got %d", dkg.EpochID, msg.EpochID)
	}
	if st.Height > dkg.CommitDeadline {
		return nil, fmt.Errorf("commit deadline passed")
	}
	if msg.DealerID == "" {
		return nil, fmt.Errorf("missing dealerId")
	}
	if findDKGMember(dkg, msg.DealerID) == nil {
		return nil, fmt.Errorf("dealer not in committee")
	}
	if findDKGCommit(dkg, msg.DealerID) != nil {
		return nil, fmt.Errorf("commit already submitted")
	}
	if len(msg.Commitments) != int(dkg.Threshold) {
		return nil, fmt.Errorf("commitments length mismatch: expected %d got %d", dkg.Threshold, len(msg.Commitments))
	}
	commitments := make([][]byte, 0, len(msg.Commitments))
	for i, c := range msg.Commitments {
		if len(c) != ocpcrypto.PointBytes {
			return nil, fmt.Errorf("commitment[%d] must be 32 bytes", i)
		}
		if _, err := ocpcrypto.PointFromBytesCanonical(c); err != nil {
			return nil, fmt.Errorf("commitment[%d] invalid: %w", i, err)
		}
		commitments = append(commitments, append([]byte(nil), c...))
	}
	dkg.Commits = append(dkg.Commits, state.DealerDKGCommit{
		DealerID:    msg.DealerID,
		Commitments: commitments,
	})
	sort.Slice(dkg.Commits, func(i, j int) bool { return dkg.Commits[i].DealerID < dkg.Commits[j].DealerID })

	return okEvent("DKGCommitAccepted", map[string]string{
		"epochId":  fmt.Sprintf("%d", dkg.EpochID),
		"dealerId": msg.DealerID,
	}), nil
}

func dealerDKGComplaintMissing(st *state.State, msg codec.DealerDKGComplaintMissingTx) (*abci.ExecTxResult, error) {
	if st == nil || st.Dealer == nil || st.Dealer.DKG == nil {
		return nil, fmt.Errorf("no dkg in progress")
	}
	dkg := st.Dealer.DKG
	if msg.EpochID != dkg.EpochID {
		return nil, fmt.Errorf("epochId mismatch: expected %d got %d", dkg.EpochID, msg.EpochID)
	}
	if st.Height < dkg.CommitDeadline {
		return nil, fmt.Errorf("complaints not yet allowed")
	}
	if st.Height > dkg.ComplaintDeadline {
		return nil, fmt.Errorf("complaint deadline passed")
	}
	if msg.ComplainerID == "" || msg.DealerID == "" {
		return nil, fmt.Errorf("missing complainerId/dealerId")
	}
	if msg.ComplainerID == msg.DealerID {
		return nil, fmt.Errorf("complainer and dealer must differ")
	}
	if findDKGMember(dkg, msg.ComplainerID) == nil {
		return nil, fmt.Errorf("complainer not in committee")
	}
	if findDKGMember(dkg, msg.DealerID) == nil {
		return nil, fmt.Errorf("dealer not in committee")
	}
	if findDKGComplaint(dkg, msg.ComplainerID, msg.DealerID) != nil {
		return nil, fmt.Errorf("complaint already filed")
	}
	dkg.Complaints = append(dkg.Complaints, state.DealerDKGComplaint{
		EpochID:      dkg.EpochID,
		ComplainerID: msg.ComplainerID,
		DealerID:     msg.DealerID,
		Kind:         "missing",
	})
	sort.Slice(dkg.Complaints, func(i, j int) bool {
		if dkg.Complaints[i].DealerID != dkg.Complaints[j].DealerID {
			return dkg.Complaints[i].DealerID < dkg.Complaints[j].DealerID
		}
		return dkg.Complaints[i].ComplainerID < dkg.Complaints[j].ComplainerID
	})
	return okEvent("DKGComplaintAccepted", map[string]string{
		"epochId":      fmt.Sprintf("%d", dkg.EpochID),
		"dealerId":     msg.DealerID,
		"complainerId": msg.ComplainerID,
		"kind":         "missing",
	}), nil
}

func dealerDKGComplaintInvalid(st *state.State, msg codec.DealerDKGComplaintInvalidTx) (*abci.ExecTxResult, error) {
	if st == nil || st.Dealer == nil || st.Dealer.DKG == nil {
		return nil, fmt.Errorf("no dkg in progress")
	}
	dkg := st.Dealer.DKG
	if msg.EpochID != dkg.EpochID {
		return nil, fmt.Errorf("epochId mismatch: expected %d got %d", dkg.EpochID, msg.EpochID)
	}
	if st.Height < dkg.CommitDeadline {
		return nil, fmt.Errorf("complaints not yet allowed")
	}
	if st.Height > dkg.ComplaintDeadline {
		return nil, fmt.Errorf("complaint deadline passed")
	}
	if msg.ComplainerID == "" || msg.DealerID == "" {
		return nil, fmt.Errorf("missing complainerId/dealerId")
	}
	if msg.ComplainerID == msg.DealerID {
		return nil, fmt.Errorf("complainer and dealer must differ")
	}
	if len(msg.ShareMsg) == 0 {
		return nil, fmt.Errorf("missing shareMsg")
	}
	if findDKGMember(dkg, msg.ComplainerID) == nil {
		return nil, fmt.Errorf("complainer not in committee")
	}
	if findDKGMember(dkg, msg.DealerID) == nil {
		return nil, fmt.Errorf("dealer not in committee")
	}
	if findDKGComplaint(dkg, msg.ComplainerID, msg.DealerID) != nil {
		return nil, fmt.Errorf("complaint already filed")
	}

	shareMsg, err := decodeDKGShareMsgV1(msg.ShareMsg)
	if err != nil {
		return nil, err
	}
	if shareMsg.EpochID != dkg.EpochID {
		return nil, fmt.Errorf("shareMsg epochId mismatch")
	}
	if shareMsg.DealerID != msg.DealerID {
		return nil, fmt.Errorf("shareMsg dealerId mismatch")
	}
	if shareMsg.ToID != msg.ComplainerID {
		return nil, fmt.Errorf("shareMsg toId mismatch")
	}
	vDealer := findValidator(st, msg.DealerID)
	if vDealer == nil || len(vDealer.PubKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("dealer validator missing pubKey")
	}
	sigMsg := append(append([]byte(dkgShareMsgDomainV1), 0), shareMsg.Body...)
	if !ed25519.Verify(ed25519.PublicKey(vDealer.PubKey), sigMsg, shareMsg.Sig) {
		return nil, fmt.Errorf("invalid shareMsg signature")
	}

	// Verify share against on-chain commitments. If invalid, slash dealer immediately (objective evidence).
	var slashedAmt uint64
	commit := findDKGCommit(dkg, msg.DealerID)
	toMem := findDKGMember(dkg, msg.ComplainerID)
	if toMem == nil {
		return nil, fmt.Errorf("complainer not in committee")
	}
	if commit == nil {
		// Missing commit after the commit deadline is slashable.
		dkgSlash(dkg, msg.DealerID)
		slashedAmt, err = jailAndSlashValidator(st, msg.DealerID, slashBpsDKG)
		if err != nil {
			return nil, err
		}
		dkgMarkPenalized(dkg, msg.DealerID)
	} else {
		ok, err := dkgVerifyShare(commit.Commitments, toMem.Index, shareMsg.Share)
		if err != nil {
			return nil, err
		}
		if ok {
			return nil, fmt.Errorf("share matches commitments")
		}
		dkgSlash(dkg, msg.DealerID)
		slashedAmt, err = jailAndSlashValidator(st, msg.DealerID, slashBpsDKG)
		if err != nil {
			return nil, err
		}
		dkgMarkPenalized(dkg, msg.DealerID)
	}

	dkg.Complaints = append(dkg.Complaints, state.DealerDKGComplaint{
		EpochID:      dkg.EpochID,
		ComplainerID: msg.ComplainerID,
		DealerID:     msg.DealerID,
		Kind:         "invalid",
		ShareMsg:     append([]byte(nil), msg.ShareMsg...),
	})
	sort.Slice(dkg.Complaints, func(i, j int) bool {
		if dkg.Complaints[i].DealerID != dkg.Complaints[j].DealerID {
			return dkg.Complaints[i].DealerID < dkg.Complaints[j].DealerID
		}
		return dkg.Complaints[i].ComplainerID < dkg.Complaints[j].ComplainerID
	})
	res := okEvent("DKGComplaintAccepted", map[string]string{
		"epochId":      fmt.Sprintf("%d", dkg.EpochID),
		"dealerId":     msg.DealerID,
		"complainerId": msg.ComplainerID,
		"kind":         "invalid",
	})
	if slashedAmt > 0 || dkgIsSlashed(dkg, msg.DealerID) {
		res.Events = append(res.Events, abci.Event{
			Type: "ValidatorSlashed",
			Attributes: []abci.EventAttribute{
				{Key: "epochId", Value: fmt.Sprintf("%d", dkg.EpochID), Index: true},
				{Key: "validatorId", Value: msg.DealerID, Index: true},
				{Key: "reason", Value: "dkg-invalid-share", Index: false},
				{Key: "amount", Value: fmt.Sprintf("%d", slashedAmt), Index: false},
			},
		})
	}
	return res, nil
}

func dkgEvalCommitment(commitments [][]byte, x uint32) (ocpcrypto.Point, error) {
	xs := ocpcrypto.ScalarFromUint64(uint64(x))
	pow := ocpcrypto.ScalarFromUint64(1)
	acc := ocpcrypto.PointZero()
	for i, cBytes := range commitments {
		c, err := ocpcrypto.PointFromBytesCanonical(cBytes)
		if err != nil {
			return ocpcrypto.PointZero(), fmt.Errorf("commitment[%d] invalid: %w", i, err)
		}
		acc = ocpcrypto.PointAdd(acc, ocpcrypto.MulPoint(c, pow))
		pow = ocpcrypto.ScalarMul(pow, xs)
	}
	return acc, nil
}

func dkgVerifyShare(commitments [][]byte, toIndex uint32, shareBytes []byte) (bool, error) {
	if len(shareBytes) != ocpcrypto.ScalarBytes {
		return false, fmt.Errorf("share must be 32 bytes")
	}
	share, err := ocpcrypto.ScalarFromBytesCanonical(shareBytes)
	if err != nil {
		return false, err
	}
	left := ocpcrypto.MulBase(share)
	right, err := dkgEvalCommitment(commitments, toIndex)
	if err != nil {
		return false, err
	}
	return ocpcrypto.PointEq(left, right), nil
}

func dealerDKGShareReveal(st *state.State, msg codec.DealerDKGShareRevealTx) (*abci.ExecTxResult, error) {
	if st == nil || st.Dealer == nil || st.Dealer.DKG == nil {
		return nil, fmt.Errorf("no dkg in progress")
	}
	dkg := st.Dealer.DKG
	if msg.EpochID != dkg.EpochID {
		return nil, fmt.Errorf("epochId mismatch: expected %d got %d", dkg.EpochID, msg.EpochID)
	}
	if st.Height > dkg.RevealDeadline {
		return nil, fmt.Errorf("reveal deadline passed")
	}
	if msg.DealerID == "" || msg.ToID == "" {
		return nil, fmt.Errorf("missing dealerId/toId")
	}
	if msg.DealerID == msg.ToID {
		return nil, fmt.Errorf("dealer and toId must differ")
	}
	if findDKGMember(dkg, msg.DealerID) == nil {
		return nil, fmt.Errorf("dealer not in committee")
	}
	toMem := findDKGMember(dkg, msg.ToID)
	if toMem == nil {
		return nil, fmt.Errorf("toId not in committee")
	}
	if findDKGComplaint(dkg, msg.ToID, msg.DealerID) == nil {
		return nil, fmt.Errorf("no complaint for this dealer/toId")
	}
	if findDKGReveal(dkg, msg.DealerID, msg.ToID) != nil {
		return nil, fmt.Errorf("reveal already submitted")
	}

	commit := findDKGCommit(dkg, msg.DealerID)
	if commit == nil {
		return nil, fmt.Errorf("dealer has not committed")
	}
	ok, err := dkgVerifyShare(commit.Commitments, toMem.Index, msg.Share)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("share does not match commitments")
	}

	dkg.Reveals = append(dkg.Reveals, state.DealerDKGShareReveal{
		EpochID:  dkg.EpochID,
		DealerID: msg.DealerID,
		ToID:     msg.ToID,
		Share:    append([]byte(nil), msg.Share...),
	})
	sort.Slice(dkg.Reveals, func(i, j int) bool {
		if dkg.Reveals[i].DealerID != dkg.Reveals[j].DealerID {
			return dkg.Reveals[i].DealerID < dkg.Reveals[j].DealerID
		}
		return dkg.Reveals[i].ToID < dkg.Reveals[j].ToID
	})
	return okEvent("DKGShareRevealed", map[string]string{
		"epochId":  fmt.Sprintf("%d", dkg.EpochID),
		"dealerId": msg.DealerID,
		"toId":     msg.ToID,
	}), nil
}

func dkgTranscriptRoot(dkg *state.DealerDKG) ([]byte, error) {
	if dkg == nil {
		return nil, fmt.Errorf("dkg is nil")
	}
	// v0 placeholder: sha256 over a canonical JSON encoding of the accepted transcript state.
	view := struct {
		EpochID           uint64                       `json:"epochId"`
		Threshold         uint8                        `json:"threshold"`
		Members           []state.DealerMember         `json:"members"`
		StartHeight       int64                        `json:"startHeight"`
		CommitDeadline    int64                        `json:"commitDeadline"`
		ComplaintDeadline int64                        `json:"complaintDeadline"`
		RevealDeadline    int64                        `json:"revealDeadline"`
		FinalizeDeadline  int64                        `json:"finalizeDeadline"`
		RandEpoch         []byte                       `json:"randEpoch,omitempty"`
		Commits           []state.DealerDKGCommit      `json:"commits,omitempty"`
		Complaints        []state.DealerDKGComplaint   `json:"complaints,omitempty"`
		Reveals           []state.DealerDKGShareReveal `json:"reveals,omitempty"`
		Slashed           []string                     `json:"slashed,omitempty"`
		Penalized         []string                     `json:"penalized,omitempty"`
	}{
		EpochID:           dkg.EpochID,
		Threshold:         dkg.Threshold,
		Members:           dkg.Members,
		StartHeight:       dkg.StartHeight,
		CommitDeadline:    dkg.CommitDeadline,
		ComplaintDeadline: dkg.ComplaintDeadline,
		RevealDeadline:    dkg.RevealDeadline,
		FinalizeDeadline:  dkg.FinalizeDeadline,
		RandEpoch:         dkg.RandEpoch,
		Commits:           dkg.Commits,
		Complaints:        dkg.Complaints,
		Reveals:           dkg.Reveals,
		Slashed:           dkg.Slashed,
		Penalized:         dkg.Penalized,
	}
	b, err := json.Marshal(view)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(append([]byte(dkgTranscriptDomain), b...))
	return sum[:], nil
}

func dealerFinalizeEpoch(st *state.State, msg codec.DealerFinalizeEpochTx) (*abci.ExecTxResult, error) {
	if st == nil || st.Dealer == nil || st.Dealer.DKG == nil {
		return nil, fmt.Errorf("no dkg in progress")
	}
	dkg := st.Dealer.DKG
	if msg.EpochID != dkg.EpochID {
		return nil, fmt.Errorf("epochId mismatch: expected %d got %d", dkg.EpochID, msg.EpochID)
	}
	// Ensure share reveals can no longer race with finalization in the same block height.
	if st.Height <= dkg.RevealDeadline {
		return nil, fmt.Errorf("too early to finalize: height=%d revealDeadline=%d", st.Height, dkg.RevealDeadline)
	}

	// Slash for missing commits.
	for _, m := range dkg.Members {
		if findDKGCommit(dkg, m.ValidatorID) == nil {
			dkgSlash(dkg, m.ValidatorID)
		}
	}

	// Slash for unresolved complaints.
	for _, c := range dkg.Complaints {
		if dkgIsSlashed(dkg, c.DealerID) {
			continue
		}
		commit := findDKGCommit(dkg, c.DealerID)
		if commit == nil {
			dkgSlash(dkg, c.DealerID)
			continue
		}
		reveal := findDKGReveal(dkg, c.DealerID, c.ComplainerID)
		if reveal == nil {
			dkgSlash(dkg, c.DealerID)
			continue
		}
		toMem := findDKGMember(dkg, c.ComplainerID)
		if toMem == nil {
			// Shouldn't happen; complaint validated membership.
			dkgSlash(dkg, c.DealerID)
			continue
		}
		ok, err := dkgVerifyShare(commit.Commitments, toMem.Index, reveal.Share)
		if err != nil || !ok {
			dkgSlash(dkg, c.DealerID)
		}
	}

	qualDealers := make([]state.DealerMember, 0, len(dkg.Members))
	for _, m := range dkg.Members {
		if dkgIsSlashed(dkg, m.ValidatorID) {
			continue
		}
		qualDealers = append(qualDealers, m)
	}

	if len(qualDealers) < int(dkg.Threshold) {
		// Abort: keep previous active epoch (if any) and clear the in-progress DKG.
		st.Dealer.DKG = nil
		ev := okEvent("DealerEpochAborted", map[string]string{
			"epochId":   fmt.Sprintf("%d", dkg.EpochID),
			"threshold": fmt.Sprintf("%d", dkg.Threshold),
			"qual":      fmt.Sprintf("%d", len(qualDealers)),
		})
		return ev, nil
	}

	// Compute PK_E = sum_{i in QUAL} C_{i,0}.
	pk := ocpcrypto.PointZero()
	for _, m := range qualDealers {
		commit := findDKGCommit(dkg, m.ValidatorID)
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
	membersOut := make([]state.DealerMember, 0, len(dkg.Members))
	for _, m := range dkg.Members {
		x := m.Index
		Y := ocpcrypto.PointZero()
		for _, dealer := range qualDealers {
			commit := findDKGCommit(dkg, dealer.ValidatorID)
			if commit == nil {
				continue
			}
			pt, err := dkgEvalCommitment(commit.Commitments, x)
			if err != nil {
				return nil, err
			}
			Y = ocpcrypto.PointAdd(Y, pt)
		}
		m.PubShare = Y.Bytes()
		membersOut = append(membersOut, m)
	}

	// Canonicalize member ordering for deterministic epoch state.
	sort.Slice(membersOut, func(i, j int) bool {
		if membersOut[i].ValidatorID != membersOut[j].ValidatorID {
			return membersOut[i].ValidatorID < membersOut[j].ValidatorID
		}
		return membersOut[i].Index < membersOut[j].Index
	})

	root, err := dkgTranscriptRoot(dkg)
	if err != nil {
		return nil, err
	}

	st.Dealer.Epoch = &state.DealerEpoch{
		EpochID:        dkg.EpochID,
		Threshold:      dkg.Threshold,
		PKEpoch:        pk.Bytes(),
		TranscriptRoot: root,
		Members:        membersOut,
		Slashed:        append([]string(nil), dkg.Slashed...),
	}

	// Clear in-progress DKG.
	st.Dealer.DKG = nil

	res := okEvent("DealerEpochFinalized", map[string]string{
		"epochId":        fmt.Sprintf("%d", st.Dealer.Epoch.EpochID),
		"threshold":      fmt.Sprintf("%d", st.Dealer.Epoch.Threshold),
		"committeeSize":  fmt.Sprintf("%d", len(st.Dealer.Epoch.Members)),
		"transcriptRoot": fmt.Sprintf("%x", root),
		"slashed":        fmt.Sprintf("%d", len(dkg.Slashed)),
	})
	for _, vid := range dkg.Slashed {
		if dkgIsPenalized(dkg, vid) {
			continue
		}
		amt, err := jailAndSlashValidator(st, vid, slashBpsDKG)
		if err != nil {
			return nil, err
		}
		dkgMarkPenalized(dkg, vid)
		res.Events = append(res.Events, abci.Event{
			Type: "ValidatorSlashed",
			Attributes: []abci.EventAttribute{
				{Key: "epochId", Value: fmt.Sprintf("%d", st.Dealer.Epoch.EpochID), Index: true},
				{Key: "validatorId", Value: vid, Index: true},
				{Key: "reason", Value: "dkg", Index: false},
				{Key: "amount", Value: fmt.Sprintf("%d", amt), Index: false},
			},
		})
	}
	return res, nil
}

func dealerDKGTimeout(st *state.State, msg codec.DealerDKGTimeoutTx) (*abci.ExecTxResult, error) {
	if st == nil || st.Dealer == nil || st.Dealer.DKG == nil {
		return nil, fmt.Errorf("no dkg in progress")
	}
	dkg := st.Dealer.DKG
	if msg.EpochID != dkg.EpochID {
		return nil, fmt.Errorf("epochId mismatch: expected %d got %d", dkg.EpochID, msg.EpochID)
	}
	if st.Height <= dkg.CommitDeadline {
		return nil, fmt.Errorf("too early for dkg timeout: height=%d commitDeadline=%d", st.Height, dkg.CommitDeadline)
	}

	events := []abci.Event{
		{
			Type: "DKGTimeoutApplied",
			Attributes: []abci.EventAttribute{
				{Key: "epochId", Value: fmt.Sprintf("%d", dkg.EpochID), Index: true},
				{Key: "height", Value: fmt.Sprintf("%d", st.Height), Index: true},
			},
		},
	}

	// Apply slashing for missing commits once the commit deadline passes.
	for _, m := range dkg.Members {
		if findDKGCommit(dkg, m.ValidatorID) != nil {
			continue
		}
		if dkgIsSlashed(dkg, m.ValidatorID) {
			continue
		}
		dkgSlash(dkg, m.ValidatorID)
		amt, err := jailAndSlashValidator(st, m.ValidatorID, slashBpsDKG)
		if err != nil {
			return nil, err
		}
		dkgMarkPenalized(dkg, m.ValidatorID)
		events = append(events, abci.Event{
			Type: "ValidatorSlashed",
			Attributes: []abci.EventAttribute{
				{Key: "epochId", Value: fmt.Sprintf("%d", dkg.EpochID), Index: true},
				{Key: "validatorId", Value: m.ValidatorID, Index: true},
				{Key: "reason", Value: "dkg-commit-timeout", Index: false},
				{Key: "amount", Value: fmt.Sprintf("%d", amt), Index: false},
			},
		})
	}

	qualDealers := make([]state.DealerMember, 0, len(dkg.Members))
	for _, m := range dkg.Members {
		if dkgIsSlashed(dkg, m.ValidatorID) {
			continue
		}
		qualDealers = append(qualDealers, m)
	}

	if len(qualDealers) < int(dkg.Threshold) {
		// Abort early if the DKG can no longer reach threshold (liveness).
		st.Dealer.DKG = nil
		events = append(events, abci.Event{
			Type: "DealerEpochAborted",
			Attributes: []abci.EventAttribute{
				{Key: "epochId", Value: fmt.Sprintf("%d", dkg.EpochID), Index: true},
				{Key: "threshold", Value: fmt.Sprintf("%d", dkg.Threshold), Index: true},
				{Key: "qual", Value: fmt.Sprintf("%d", len(qualDealers)), Index: true},
				{Key: "reason", Value: "dkg-below-threshold", Index: false},
			},
		})
		return &abci.ExecTxResult{Code: 0, Events: events}, nil
	}

	// If the reveal deadline passed, finalize deterministically.
	if st.Height > dkg.RevealDeadline {
		res, err := dealerFinalizeEpoch(st, codec.DealerFinalizeEpochTx{EpochID: msg.EpochID})
		if err != nil {
			return nil, err
		}
		res.Events = append(events, res.Events...)
		return res, nil
	}

	return &abci.ExecTxResult{Code: 0, Events: events}, nil
}

func dealerInitHand(st *state.State, t *state.Table, msg codec.DealerInitHandTx, nowUnix int64) (*abci.ExecTxResult, error) {
	if t == nil || t.Hand == nil {
		return nil, fmt.Errorf("no active hand")
	}
	h := t.Hand
	if h.Phase != state.PhaseShuffle {
		return nil, fmt.Errorf("hand not in shuffle phase")
	}
	if msg.HandID != h.HandID {
		return nil, fmt.Errorf("handId mismatch: expected %d got %d", h.HandID, msg.HandID)
	}
	if h.Dealer != nil {
		return nil, fmt.Errorf("dealer hand already initialized")
	}
	epoch := st.Dealer.Epoch
	if epoch == nil {
		return nil, fmt.Errorf("no active dealer epoch")
	}
	if msg.EpochID != epoch.EpochID {
		return nil, fmt.Errorf("epochId mismatch: expected %d got %d", epoch.EpochID, msg.EpochID)
	}
	deckSize := msg.DeckSize
	if deckSize == 0 {
		deckSize = 52
	}
	if deckSize < 2 || deckSize > 52 {
		return nil, fmt.Errorf("invalid deckSize %d", deckSize)
	}

	k, err := deriveHandScalar(epoch.EpochID, t.ID, h.HandID)
	if err != nil {
		return nil, err
	}

	pkEpoch, err := ocpcrypto.PointFromBytesCanonical(epoch.PKEpoch)
	if err != nil {
		return nil, fmt.Errorf("pkEpoch invalid: %w", err)
	}
	pkHand := ocpcrypto.MulPoint(pkEpoch, k)

	kBytes := k.Bytes()
	deck := make([]state.DealerCiphertext, 0, deckSize)
	for i := 0; i < int(deckSize); i++ {
		m := cardPoint(i)
		r, err := hashToNonzeroScalar(deckInitDomain, kBytes, u16le(uint16(i)))
		if err != nil {
			return nil, err
		}
		ct, err := ocpcrypto.ElGamalEncrypt(pkHand, m, r)
		if err != nil {
			return nil, err
		}
		deck = append(deck, state.DealerCiphertext{
			C1: append([]byte(nil), ct.C1.Bytes()...),
			C2: append([]byte(nil), ct.C2.Bytes()...),
		})
	}

	to := tableDealerTimeoutSecs(t)
	shuffleDeadline, err := addInt64AndU64Checked(nowUnix, to, "dealer shuffle deadline")
	if err != nil {
		return nil, err
	}
	h.Dealer = &state.DealerHand{
		EpochID:  epoch.EpochID,
		PKHand:   append([]byte(nil), pkHand.Bytes()...),
		DeckSize: deckSize,
		Deck:     deck,

		ShuffleDeadline:    shuffleDeadline,
		HoleSharesDeadline: 0,
		RevealPos:          255,
		RevealDeadline:     0,
	}

	ev := okEvent("DealerHandInitialized", map[string]string{
		"tableId":  fmt.Sprintf("%d", t.ID),
		"handId":   fmt.Sprintf("%d", h.HandID),
		"epochId":  fmt.Sprintf("%d", epoch.EpochID),
		"deckSize": fmt.Sprintf("%d", deckSize),
	})
	return ev, nil
}

func dealerSubmitShuffle(st *state.State, t *state.Table, msg codec.DealerSubmitShuffleTx, nowUnix int64) (*abci.ExecTxResult, error) {
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, fmt.Errorf("dealer hand not initialized")
	}
	h := t.Hand
	if h.Phase != state.PhaseShuffle {
		return nil, fmt.Errorf("hand not in shuffle phase")
	}
	dh := h.Dealer
	if dh.ShuffleDeadline != 0 && nowUnix >= dh.ShuffleDeadline {
		return nil, fmt.Errorf("shuffle deadline passed; call dealer/timeout")
	}
	if msg.HandID != h.HandID {
		return nil, fmt.Errorf("handId mismatch")
	}
	if dh.Finalized {
		return nil, fmt.Errorf("deck already finalized")
	}
	if msg.Round != dh.ShuffleStep+1 {
		return nil, fmt.Errorf("round mismatch: expected %d got %d", dh.ShuffleStep+1, msg.Round)
	}
	if msg.ShufflerID == "" {
		return nil, fmt.Errorf("missing shufflerId")
	}
	if st == nil || st.Dealer == nil {
		return nil, fmt.Errorf("state missing dealer epoch")
	}
	epoch := st.Dealer.Epoch
	if epoch == nil || epoch.EpochID != dh.EpochID {
		return nil, fmt.Errorf("epoch not available")
	}
	if findEpochMember(epoch, msg.ShufflerID) == nil {
		return nil, fmt.Errorf("shuffler not in committee")
	}
	if epochIsSlashed(epoch, msg.ShufflerID) {
		return nil, fmt.Errorf("shuffler is slashed")
	}
	qual := epochQualMembers(epoch)
	if int(dh.ShuffleStep) >= len(qual) {
		return nil, fmt.Errorf("no qualified shuffler available")
	}
	expectID := qual[dh.ShuffleStep].ValidatorID
	if msg.ShufflerID != expectID {
		return nil, fmt.Errorf("unexpected shuffler: expected %s got %s", expectID, msg.ShufflerID)
	}
	if len(msg.ProofBytes) == 0 {
		return nil, fmt.Errorf("missing proofShuffle")
	}

	pkHand, err := ocpcrypto.PointFromBytesCanonical(dh.PKHand)
	if err != nil {
		return nil, fmt.Errorf("pkHand invalid: %w", err)
	}

	deckIn := make([]ocpcrypto.ElGamalCiphertext, 0, len(dh.Deck))
	for _, c := range dh.Deck {
		c1, err := ocpcrypto.PointFromBytesCanonical(c.C1)
		if err != nil {
			return nil, fmt.Errorf("deck c1 invalid: %w", err)
		}
		c2, err := ocpcrypto.PointFromBytesCanonical(c.C2)
		if err != nil {
			return nil, fmt.Errorf("deck c2 invalid: %w", err)
		}
		deckIn = append(deckIn, ocpcrypto.ElGamalCiphertext{C1: c1, C2: c2})
	}

	vr := ocpshuffle.ShuffleVerifyV1(pkHand, deckIn, msg.ProofBytes)
	if !vr.OK {
		return nil, fmt.Errorf("shuffle verify failed: %s", vr.Error)
	}

	deckOut := make([]state.DealerCiphertext, 0, len(vr.DeckOut))
	for _, ct := range vr.DeckOut {
		deckOut = append(deckOut, state.DealerCiphertext{
			C1: append([]byte(nil), ct.C1.Bytes()...),
			C2: append([]byte(nil), ct.C2.Bytes()...),
		})
	}
	dh.Deck = deckOut
	dh.ShuffleStep = msg.Round
	shuffleDeadline, err := addInt64AndU64Checked(nowUnix, tableDealerTimeoutSecs(t), "dealer shuffle deadline")
	if err != nil {
		return nil, err
	}
	dh.ShuffleDeadline = shuffleDeadline

	sum := sha256.Sum256(msg.ProofBytes)
	proofHash := hex.EncodeToString(sum[:])

	ev := okEvent("ShuffleAccepted", map[string]string{
		"tableId":    fmt.Sprintf("%d", t.ID),
		"handId":     fmt.Sprintf("%d", h.HandID),
		"round":      fmt.Sprintf("%d", msg.Round),
		"shufflerId": msg.ShufflerID,
		"proofHash":  proofHash,
	})
	return ev, nil
}

func dealerFinalizeDeck(st *state.State, t *state.Table, msg codec.DealerFinalizeDeckTx, nowUnix int64) (*abci.ExecTxResult, error) {
	if st == nil || st.Dealer == nil {
		return nil, fmt.Errorf("state missing dealer epoch")
	}
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, fmt.Errorf("dealer hand not initialized")
	}
	h := t.Hand
	if h.Phase != state.PhaseShuffle {
		return nil, fmt.Errorf("hand not in shuffle phase")
	}
	dh := h.Dealer
	if msg.HandID != h.HandID {
		return nil, fmt.Errorf("handId mismatch")
	}
	if dh.Finalized {
		return nil, fmt.Errorf("deck already finalized")
	}
	epoch := st.Dealer.Epoch
	if epoch == nil || epoch.EpochID != dh.EpochID {
		return nil, fmt.Errorf("epoch not available")
	}
	qual := epochQualMembers(epoch)
	if len(qual) < int(epoch.Threshold) {
		return nil, fmt.Errorf("insufficient qualified members: have %d need %d", len(qual), epoch.Threshold)
	}
	// Require every QUAL member to contribute exactly one shuffle in deterministic order. This ensures that
	// as long as at least one QUAL member is honest, no single party can know the final deck order.
	if int(dh.ShuffleStep) != len(qual) {
		return nil, fmt.Errorf("deck must be shuffled by all qualified members before finalization: have %d need %d", dh.ShuffleStep, len(qual))
	}
	dh.Finalized = true

	// Assign hole card deck positions deterministically (DealerStub still exists, but this is the
	// interface surface needed for private dealing).
	holePos := make([]uint8, 18)
	for i := range holePos {
		holePos[i] = 255
	}
	order := holeDealOrder(t)
	pos := uint8(0)
	for c := 0; c < 2; c++ {
		for _, seatIdx := range order {
			if int(pos) >= len(dh.Deck) {
				break
			}
			holePos[seatIdx*2+c] = pos
			pos++
		}
	}
	dh.HolePos = holePos
	dh.Cursor = pos
	dh.ShuffleDeadline = 0
	holeSharesDeadline, err := addInt64AndU64Checked(nowUnix, tableDealerTimeoutSecs(t), "dealer hole shares deadline")
	if err != nil {
		return nil, err
	}
	dh.HoleSharesDeadline = holeSharesDeadline
	dh.RevealPos = 255
	dh.RevealDeadline = 0

	ev := okEvent("DeckFinalized", map[string]string{
		"tableId": fmt.Sprintf("%d", t.ID),
		"handId":  fmt.Sprintf("%d", h.HandID),
	})
	return ev, nil
}

func holeDealOrder(t *state.Table) []int {
	h := t.Hand
	if h == nil {
		return nil
	}
	start := h.SmallBlindSeat
	if start < 0 || start >= 9 {
		start = 0
	}
	order := []int{}
	cur := start
	for {
		if h.InHand[cur] {
			order = append(order, cur)
		}
		cur = (cur + 1) % 9
		if cur == start {
			break
		}
	}
	return order
}

func findEpochMember(epoch *state.DealerEpoch, validatorID string) *state.DealerMember {
	if epoch == nil {
		return nil
	}
	for i := range epoch.Members {
		if epoch.Members[i].ValidatorID == validatorID {
			return &epoch.Members[i]
		}
	}
	return nil
}

func epochIsSlashed(epoch *state.DealerEpoch, validatorID string) bool {
	if epoch == nil || validatorID == "" || len(epoch.Slashed) == 0 {
		return false
	}
	i := sort.SearchStrings(epoch.Slashed, validatorID)
	return i < len(epoch.Slashed) && epoch.Slashed[i] == validatorID
}

func epochSlash(epoch *state.DealerEpoch, validatorID string) bool {
	if epoch == nil || validatorID == "" {
		return false
	}
	if epochIsSlashed(epoch, validatorID) {
		return false
	}
	i := sort.SearchStrings(epoch.Slashed, validatorID)
	epoch.Slashed = append(epoch.Slashed, "")
	copy(epoch.Slashed[i+1:], epoch.Slashed[i:])
	epoch.Slashed[i] = validatorID
	return true
}

func epochQualMembers(epoch *state.DealerEpoch) []state.DealerMember {
	if epoch == nil {
		return nil
	}
	out := make([]state.DealerMember, 0, len(epoch.Members))
	for _, m := range epoch.Members {
		if epochIsSlashed(epoch, m.ValidatorID) {
			continue
		}
		out = append(out, m)
	}
	return out
}

func dealerMissingPubShares(epoch *state.DealerEpoch, dh *state.DealerHand, pos uint8) []string {
	if epoch == nil || dh == nil {
		return nil
	}
	have := map[string]bool{}
	for _, ps := range dh.PubShares {
		if ps.Pos != pos {
			continue
		}
		have[ps.ValidatorID] = true
	}

	missing := []string{}
	for _, m := range epochQualMembers(epoch) {
		if have[m.ValidatorID] {
			continue
		}
		missing = append(missing, m.ValidatorID)
	}
	// Deterministic ordering for event emission.
	sort.Strings(missing)
	return missing
}

func dealerMissingHoleEncShares(epoch *state.DealerEpoch, t *state.Table) ([]string, error) {
	if epoch == nil || t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, fmt.Errorf("missing dealer hand")
	}
	h := t.Hand
	dh := h.Dealer
	if len(dh.HolePos) != 18 {
		return nil, fmt.Errorf("holePos not initialized")
	}

	required := make([]uint8, 0, 18)
	for seat := 0; seat < 9; seat++ {
		if !h.InHand[seat] {
			continue
		}
		for c := 0; c < 2; c++ {
			pos := dh.HolePos[seat*2+c]
			if pos == 255 {
				return nil, fmt.Errorf("holePos unset for seat %d", seat)
			}
			required = append(required, pos)
		}
	}

	have := map[string]map[uint8]bool{}
	for _, es := range dh.EncShares {
		m := have[es.ValidatorID]
		if m == nil {
			m = map[uint8]bool{}
			have[es.ValidatorID] = m
		}
		m[es.Pos] = true
	}

	missing := []string{}
	for _, m := range epochQualMembers(epoch) {
		id := m.ValidatorID
		ok := true
		mm := have[id]
		if mm == nil {
			ok = false
		} else {
			for _, pos := range required {
				if !mm[pos] {
					ok = false
					break
				}
			}
		}
		if !ok {
			missing = append(missing, id)
		}
	}
	sort.Strings(missing)
	return missing, nil
}

func dealerSubmitPubShare(st *state.State, t *state.Table, msg codec.DealerSubmitPubShareTx, nowUnix int64) (*abci.ExecTxResult, error) {
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, fmt.Errorf("dealer hand not initialized")
	}
	h := t.Hand
	dh := h.Dealer
	if msg.HandID != h.HandID {
		return nil, fmt.Errorf("handId mismatch")
	}
	if msg.ValidatorID == "" {
		return nil, fmt.Errorf("missing validatorId")
	}
	expectPos, awaiting, err := dealerExpectedRevealPos(t)
	if err != nil {
		return nil, err
	}
	if !awaiting {
		return nil, fmt.Errorf("hand not awaiting a reveal")
	}
	if msg.Pos != expectPos {
		return nil, fmt.Errorf("pos not currently revealable")
	}
	if dh.RevealPos != expectPos || dh.RevealDeadline == 0 {
		return nil, fmt.Errorf("reveal deadline not initialized")
	}
	if nowUnix >= dh.RevealDeadline {
		return nil, fmt.Errorf("reveal deadline passed; call dealer/timeout")
	}
	if int(msg.Pos) >= len(dh.Deck) {
		return nil, fmt.Errorf("pos out of bounds")
	}
	epoch := st.Dealer.Epoch
	if epoch == nil || epoch.EpochID != dh.EpochID {
		return nil, fmt.Errorf("epoch not available")
	}
	mem := findEpochMember(epoch, msg.ValidatorID)
	if mem == nil {
		return nil, fmt.Errorf("validator not in committee")
	}
	if epochIsSlashed(epoch, msg.ValidatorID) {
		return nil, fmt.Errorf("validator is slashed")
	}

	// Prevent duplicates.
	for _, ps := range dh.PubShares {
		if ps.Pos == msg.Pos && ps.ValidatorID == msg.ValidatorID {
			return nil, fmt.Errorf("duplicate pub share")
		}
	}

	k, err := deriveHandScalar(dh.EpochID, t.ID, h.HandID)
	if err != nil {
		return nil, err
	}
	Yepoch, err := ocpcrypto.PointFromBytesCanonical(mem.PubShare)
	if err != nil {
		return nil, fmt.Errorf("pubShare invalid: %w", err)
	}
	Yhand := ocpcrypto.MulPoint(Yepoch, k)

	c1, err := ocpcrypto.PointFromBytesCanonical(dh.Deck[msg.Pos].C1)
	if err != nil {
		return nil, fmt.Errorf("ciphertext c1 invalid: %w", err)
	}
	share, err := ocpcrypto.PointFromBytesCanonical(msg.Share)
	if err != nil {
		return nil, fmt.Errorf("share invalid: %w", err)
	}
	proof, err := ocpcrypto.DecodeChaumPedersenProof(msg.Proof)
	if err != nil {
		return nil, fmt.Errorf("proof invalid: %w", err)
	}
	ok, err := ocpcrypto.ChaumPedersenVerify(Yhand, c1, share, proof)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("invalid pub share proof")
	}

	dh.PubShares = append(dh.PubShares, state.DealerPubShare{
		Pos:         msg.Pos,
		ValidatorID: msg.ValidatorID,
		Index:       mem.Index,
		Share:       append([]byte(nil), msg.Share...),
		Proof:       append([]byte(nil), msg.Proof...),
	})
	sort.Slice(dh.PubShares, func(i, j int) bool {
		if dh.PubShares[i].Pos != dh.PubShares[j].Pos {
			return dh.PubShares[i].Pos < dh.PubShares[j].Pos
		}
		return dh.PubShares[i].ValidatorID < dh.PubShares[j].ValidatorID
	})

	ev := okEvent("PubShareAccepted", map[string]string{
		"tableId":     fmt.Sprintf("%d", t.ID),
		"handId":      fmt.Sprintf("%d", h.HandID),
		"pos":         fmt.Sprintf("%d", msg.Pos),
		"validatorId": msg.ValidatorID,
	})
	return ev, nil
}

func dealerSubmitEncShare(st *state.State, t *state.Table, msg codec.DealerSubmitEncShareTx, nowUnix int64) (*abci.ExecTxResult, error) {
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, fmt.Errorf("dealer hand not initialized")
	}
	h := t.Hand
	if h.Phase != state.PhaseShuffle {
		return nil, fmt.Errorf("hand not in shuffle phase")
	}
	dh := h.Dealer
	if dh.HoleSharesDeadline == 0 {
		return nil, fmt.Errorf("hole shares deadline not initialized")
	}
	if nowUnix >= dh.HoleSharesDeadline {
		return nil, fmt.Errorf("hole shares deadline passed; call dealer/timeout")
	}
	if msg.HandID != h.HandID {
		return nil, fmt.Errorf("handId mismatch")
	}
	if msg.ValidatorID == "" {
		return nil, fmt.Errorf("missing validatorId")
	}
	if int(msg.Pos) >= len(dh.Deck) {
		return nil, fmt.Errorf("pos out of bounds")
	}
	if !dh.Finalized || len(dh.HolePos) != 18 {
		return nil, fmt.Errorf("deck not finalized")
	}
	if len(msg.PKPlayer) != ocpcrypto.PointBytes {
		return nil, fmt.Errorf("pkPlayer must be 32 bytes")
	}
	if len(msg.EncShare) != 64 {
		return nil, fmt.Errorf("encShare must be 64 bytes")
	}
	if len(msg.Proof) != 160 {
		return nil, fmt.Errorf("proofEncShare must be 160 bytes")
	}

	epoch := st.Dealer.Epoch
	if epoch == nil || epoch.EpochID != dh.EpochID {
		return nil, fmt.Errorf("epoch not available")
	}
	mem := findEpochMember(epoch, msg.ValidatorID)
	if mem == nil {
		return nil, fmt.Errorf("validator not in committee")
	}
	if epochIsSlashed(epoch, msg.ValidatorID) {
		return nil, fmt.Errorf("validator is slashed")
	}

	// Gate: enc shares are only allowed for in-hand hole positions, and must match the seat's pk.
	holeSeat := -1
	for s := 0; s < 9; s++ {
		if !h.InHand[s] {
			continue
		}
		if dh.HolePos[s*2] == msg.Pos || dh.HolePos[s*2+1] == msg.Pos {
			holeSeat = s
			break
		}
	}
	if holeSeat == -1 {
		return nil, fmt.Errorf("pos is not a hole card position")
	}
	if t.Seats[holeSeat] == nil || len(t.Seats[holeSeat].PK) != ocpcrypto.PointBytes {
		return nil, fmt.Errorf("seat missing pk")
	}
	if !bytes.Equal(t.Seats[holeSeat].PK, msg.PKPlayer) {
		return nil, fmt.Errorf("pkPlayer mismatch for seat %d", holeSeat)
	}

	// Prevent duplicates.
	for _, es := range dh.EncShares {
		if es.Pos == msg.Pos && es.ValidatorID == msg.ValidatorID {
			return nil, fmt.Errorf("duplicate enc share")
		}
	}

	k, err := deriveHandScalar(dh.EpochID, t.ID, h.HandID)
	if err != nil {
		return nil, err
	}
	Yepoch, err := ocpcrypto.PointFromBytesCanonical(mem.PubShare)
	if err != nil {
		return nil, fmt.Errorf("pubShare invalid: %w", err)
	}
	Yhand := ocpcrypto.MulPoint(Yepoch, k)

	c1Cipher, err := ocpcrypto.PointFromBytesCanonical(dh.Deck[msg.Pos].C1)
	if err != nil {
		return nil, fmt.Errorf("ciphertext c1 invalid: %w", err)
	}
	pkPlayer, err := ocpcrypto.PointFromBytesCanonical(msg.PKPlayer)
	if err != nil {
		return nil, fmt.Errorf("pkPlayer invalid: %w", err)
	}
	U, err := ocpcrypto.PointFromBytesCanonical(msg.EncShare[:32])
	if err != nil {
		return nil, fmt.Errorf("encShare.u invalid: %w", err)
	}
	V, err := ocpcrypto.PointFromBytesCanonical(msg.EncShare[32:])
	if err != nil {
		return nil, fmt.Errorf("encShare.v invalid: %w", err)
	}

	proof, err := ocpcrypto.DecodeEncShareProof(msg.Proof)
	if err != nil {
		return nil, fmt.Errorf("proofEncShare invalid: %w", err)
	}
	ok, err := ocpcrypto.EncShareVerify(Yhand, c1Cipher, pkPlayer, U, V, proof)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("invalid enc share proof")
	}

	dh.EncShares = append(dh.EncShares, state.DealerEncShare{
		Pos:         msg.Pos,
		ValidatorID: msg.ValidatorID,
		Index:       mem.Index,
		PKPlayer:    append([]byte(nil), msg.PKPlayer...),
		EncShare:    append([]byte(nil), msg.EncShare...),
		Proof:       append([]byte(nil), msg.Proof...),
	})
	sort.Slice(dh.EncShares, func(i, j int) bool {
		if dh.EncShares[i].Pos != dh.EncShares[j].Pos {
			return dh.EncShares[i].Pos < dh.EncShares[j].Pos
		}
		return dh.EncShares[i].ValidatorID < dh.EncShares[j].ValidatorID
	})

	ev := okEvent("EncShareAccepted", map[string]string{
		"tableId":     fmt.Sprintf("%d", t.ID),
		"handId":      fmt.Sprintf("%d", h.HandID),
		"pos":         fmt.Sprintf("%d", msg.Pos),
		"validatorId": msg.ValidatorID,
	})

	// If we have enough encrypted shares for all in-hand hole cards, open betting.
	if h.Phase == state.PhaseShuffle {
		ready, err := dealerHoleEncSharesReady(st, t)
		if err != nil {
			return nil, err
		}
		if ready {
			dh.HoleSharesDeadline = 0
			if h.ActionOn == -1 {
				h.Phase = state.PhaseAwaitFlop
				h.ActionOn = -1
			} else {
				h.Phase = state.PhaseBetting
			}
			if err := setRevealDeadlineIfAwaiting(t, nowUnix); err != nil {
				return nil, err
			}
			if err := setActionDeadlineIfBetting(t, nowUnix); err != nil {
				return nil, err
			}
			ev.Events = append(ev.Events, abci.Event{
				Type: "HoleCardsReady",
				Attributes: []abci.EventAttribute{
					{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
					{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
					{Key: "phase", Value: string(h.Phase), Index: true},
				},
			})
		}
	}
	return ev, nil
}

func dealerFinalizeReveal(st *state.State, t *state.Table, msg codec.DealerFinalizeRevealTx, nowUnix int64) (*abci.ExecTxResult, error) {
	if t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, fmt.Errorf("dealer hand not initialized")
	}
	h := t.Hand
	dh := h.Dealer
	if msg.HandID != h.HandID {
		return nil, fmt.Errorf("handId mismatch")
	}
	expectPos, ok, err := dealerExpectedRevealPos(t)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("hand not awaiting a reveal")
	}
	if msg.Pos != expectPos {
		return nil, fmt.Errorf("pos not currently revealable")
	}
	if dh.RevealPos != expectPos || dh.RevealDeadline == 0 {
		return nil, fmt.Errorf("reveal deadline not initialized")
	}
	if int(msg.Pos) >= len(dh.Deck) {
		return nil, fmt.Errorf("pos out of bounds")
	}
	epoch := st.Dealer.Epoch
	if epoch == nil || epoch.EpochID != dh.EpochID {
		return nil, fmt.Errorf("epoch not available")
	}
	if nowUnix >= dh.RevealDeadline {
		missing := dealerMissingPubShares(epoch, dh, msg.Pos)
		if len(missing) != 0 {
			return nil, fmt.Errorf("reveal deadline passed; call dealer/timeout")
		}
	}

	// Do not finalize twice for the same position.
	for _, r := range dh.Reveals {
		if r.Pos == msg.Pos {
			return nil, fmt.Errorf("pos already revealed")
		}
	}

	// Collect shares for this pos.
	type shareRec struct {
		validatorID string
		index       uint32
		share       ocpcrypto.Point
	}
	shares := make([]shareRec, 0)
	for _, ps := range dh.PubShares {
		if ps.Pos != msg.Pos {
			continue
		}
		p, err := ocpcrypto.PointFromBytesCanonical(ps.Share)
		if err != nil {
			return nil, fmt.Errorf("stored share invalid: %w", err)
		}
		shares = append(shares, shareRec{validatorID: ps.ValidatorID, index: ps.Index, share: p})
	}

	tNeed := int(epoch.Threshold)
	if len(shares) < tNeed {
		return nil, fmt.Errorf("insufficient shares: have %d need %d", len(shares), tNeed)
	}

	// Deterministic subset selection: sort by index then validatorId, take first t.
	sort.Slice(shares, func(i, j int) bool {
		if shares[i].index != shares[j].index {
			return shares[i].index < shares[j].index
		}
		return shares[i].validatorID < shares[j].validatorID
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

	c1, err := ocpcrypto.PointFromBytesCanonical(dh.Deck[msg.Pos].C1)
	if err != nil {
		return nil, fmt.Errorf("ciphertext c1 invalid: %w", err)
	}
	_ = c1 // c1 not needed for final decrypt once shares are already d_i = x_i*c1
	c2, err := ocpcrypto.PointFromBytesCanonical(dh.Deck[msg.Pos].C2)
	if err != nil {
		return nil, fmt.Errorf("ciphertext c2 invalid: %w", err)
	}

	pt := ocpcrypto.PointSub(c2, combined)
	cardID, err := pointToCardID(pt, int(dh.DeckSize))
	if err != nil {
		return nil, err
	}

	dh.Reveals = append(dh.Reveals, state.DealerReveal{Pos: msg.Pos, CardID: cardID})
	sort.Slice(dh.Reveals, func(i, j int) bool { return dh.Reveals[i].Pos < dh.Reveals[j].Pos })

	ev := okEvent("RevealFinalized", map[string]string{
		"tableId": fmt.Sprintf("%d", t.ID),
		"handId":  fmt.Sprintf("%d", h.HandID),
		"pos":     fmt.Sprintf("%d", msg.Pos),
		"cardId":  fmt.Sprintf("%d", cardID),
	})

	// Drive the poker state machine forward now that the card is public.
	extra, err := applyDealerRevealToPoker(t, msg.Pos, cardID, nowUnix)
	if err != nil {
		return nil, err
	}
	ev.Events = append(ev.Events, extra...)
	return ev, nil
}

func dealerHoleEncSharesReady(st *state.State, t *state.Table) (bool, error) {
	if st == nil || t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return false, nil
	}
	h := t.Hand
	dh := h.Dealer
	if !dh.Finalized || len(dh.HolePos) != 18 {
		return false, nil
	}
	epoch := st.Dealer.Epoch
	if epoch == nil || epoch.EpochID != dh.EpochID {
		return false, fmt.Errorf("epoch not available")
	}
	tNeed := int(epoch.Threshold)
	if tNeed <= 0 {
		return false, fmt.Errorf("invalid threshold")
	}

	for seat := 0; seat < 9; seat++ {
		if !h.InHand[seat] {
			continue
		}
		s := t.Seats[seat]
		if s == nil || len(s.PK) != ocpcrypto.PointBytes {
			return false, fmt.Errorf("seat %d missing pk", seat)
		}
		for c := 0; c < 2; c++ {
			pos := dh.HolePos[seat*2+c]
			if pos == 255 {
				return false, fmt.Errorf("holePos unset for seat %d", seat)
			}
			n := 0
			for _, es := range dh.EncShares {
				if es.Pos != pos {
					continue
				}
				if bytes.Equal(es.PKPlayer, s.PK) {
					n++
				}
			}
			if n < tNeed {
				return false, nil
			}
		}
	}
	return true, nil
}

func abortHandRefundAllCommits(t *state.Table, reason string) ([]abci.Event, error) {
	if t == nil || t.Hand == nil {
		return nil, nil
	}
	h := t.Hand
	handID := h.HandID

	// Refund all committed chips and clear any public hole cards.
	for i := 0; i < 9; i++ {
		if t.Seats[i] == nil {
			continue
		}
		nextStack, err := addUint64Checked(t.Seats[i].Stack, h.TotalCommit[i], "seat stack refund")
		if err != nil {
			return nil, err
		}
		t.Seats[i].Stack = nextStack
		t.Seats[i].Hole = [2]state.Card{}
	}

	t.Hand = nil

	return []abci.Event{
		{
			Type: "HandAborted",
			Attributes: []abci.EventAttribute{
				{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
				{Key: "handId", Value: fmt.Sprintf("%d", handID), Index: true},
				{Key: "reason", Value: reason, Index: false},
			},
		},
	}, nil
}

func dealerTimeout(st *state.State, t *state.Table, msg codec.DealerTimeoutTx, nowUnix int64) (*abci.ExecTxResult, error) {
	if st == nil || t == nil || t.Hand == nil || t.Hand.Dealer == nil {
		return nil, fmt.Errorf("no active dealer hand")
	}
	h := t.Hand
	dh := h.Dealer
	if msg.HandID != h.HandID {
		return nil, fmt.Errorf("handId mismatch")
	}

	epoch := st.Dealer.Epoch
	if epoch == nil || epoch.EpochID != dh.EpochID {
		return nil, fmt.Errorf("epoch not available")
	}

	to := tableDealerTimeoutSecs(t)
	if to == 0 {
		return nil, fmt.Errorf("dealerTimeoutSecs must be > 0")
	}

	events := []abci.Event{
		{
			Type: "DealerTimeoutApplied",
			Attributes: []abci.EventAttribute{
				{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
				{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
				{Key: "phase", Value: string(h.Phase), Index: true},
			},
		},
	}

	threshold := int(epoch.Threshold)
	if threshold <= 0 {
		return nil, fmt.Errorf("invalid epoch threshold")
	}

	// ---- Shuffle / Finalize ----
	if h.Phase == state.PhaseShuffle && !dh.Finalized {
		if dh.ShuffleDeadline == 0 {
			return nil, fmt.Errorf("shuffle deadline not initialized")
		}
		if nowUnix < dh.ShuffleDeadline {
			return nil, fmt.Errorf("shuffle not timed out")
		}

		qual := epochQualMembers(epoch)
		if len(qual) == 0 {
			abortEv, err := abortHandRefundAllCommits(t, "dealer: no qualified committee members")
			if err != nil {
				return nil, err
			}
			events = append(events, abortEv...)
			return &abci.ExecTxResult{Code: 0, Events: events}, nil
		}

		// If all qualified members already shuffled, allow anyone to finalize deterministically.
		if int(dh.ShuffleStep) == len(qual) {
			ev, err := dealerFinalizeDeck(st, t, codec.DealerFinalizeDeckTx{TableID: t.ID, HandID: h.HandID}, nowUnix)
			if err != nil {
				return nil, err
			}
			events = append(events, ev.Events...)
			return &abci.ExecTxResult{Code: 0, Events: events}, nil
		}
		if int(dh.ShuffleStep) > len(qual) {
			return nil, fmt.Errorf("shuffleStep out of range: step=%d qual=%d", dh.ShuffleStep, len(qual))
		}

		// Slash the expected shuffler for the next round (shuffleStep starts at 0).
		expectID := qual[dh.ShuffleStep].ValidatorID
		if epochSlash(epoch, expectID) {
			amt, err := jailAndSlashValidator(st, expectID, slashBpsHandDealer)
			if err != nil {
				return nil, err
			}
			events = append(events, abci.Event{
				Type: "ValidatorSlashed",
				Attributes: []abci.EventAttribute{
					{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
					{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
					{Key: "epochId", Value: fmt.Sprintf("%d", epoch.EpochID), Index: true},
					{Key: "validatorId", Value: expectID, Index: true},
					{Key: "reason", Value: "shuffle-timeout", Index: false},
					{Key: "amount", Value: fmt.Sprintf("%d", amt), Index: false},
				},
			})
		}

		qual = epochQualMembers(epoch)
		if len(qual) < threshold {
			abortEv, err := abortHandRefundAllCommits(t, "dealer: committee below threshold after shuffle timeout")
			if err != nil {
				return nil, err
			}
			events = append(events, abortEv...)
			return &abci.ExecTxResult{Code: 0, Events: events}, nil
		}

		// If slashing reduced QUAL enough that all remaining members already shuffled, finalize now.
		if int(dh.ShuffleStep) == len(qual) {
			ev, err := dealerFinalizeDeck(st, t, codec.DealerFinalizeDeckTx{TableID: t.ID, HandID: h.HandID}, nowUnix)
			if err != nil {
				return nil, err
			}
			events = append(events, ev.Events...)
			return &abci.ExecTxResult{Code: 0, Events: events}, nil
		}

		shuffleDeadline, err := addInt64AndU64Checked(nowUnix, to, "dealer shuffle deadline")
		if err != nil {
			return nil, err
		}
		dh.ShuffleDeadline = shuffleDeadline
		return &abci.ExecTxResult{Code: 0, Events: events}, nil
	}

	// ---- Hole Enc Shares ----
	if h.Phase == state.PhaseShuffle && dh.Finalized {
		if dh.HoleSharesDeadline == 0 {
			return nil, fmt.Errorf("hole shares deadline not initialized")
		}
		if nowUnix < dh.HoleSharesDeadline {
			return nil, fmt.Errorf("hole shares not timed out")
		}

		missing, err := dealerMissingHoleEncShares(epoch, t)
		if err != nil {
			return nil, err
		}
		for _, id := range missing {
			if epochSlash(epoch, id) {
				amt, err := jailAndSlashValidator(st, id, slashBpsHandDealer)
				if err != nil {
					return nil, err
				}
				events = append(events, abci.Event{
					Type: "ValidatorSlashed",
					Attributes: []abci.EventAttribute{
						{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
						{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
						{Key: "epochId", Value: fmt.Sprintf("%d", epoch.EpochID), Index: true},
						{Key: "validatorId", Value: id, Index: true},
						{Key: "reason", Value: "hole-enc-shares-timeout", Index: false},
						{Key: "amount", Value: fmt.Sprintf("%d", amt), Index: false},
					},
				})
			}
		}

		if len(epochQualMembers(epoch)) < threshold {
			abortEv, err := abortHandRefundAllCommits(t, "dealer: committee below threshold after hole enc shares timeout")
			if err != nil {
				return nil, err
			}
			events = append(events, abortEv...)
			return &abci.ExecTxResult{Code: 0, Events: events}, nil
		}

		ready, err := dealerHoleEncSharesReady(st, t)
		if err != nil {
			return nil, err
		}
		if !ready {
			abortEv, err := abortHandRefundAllCommits(t, "dealer: insufficient hole shares by deadline")
			if err != nil {
				return nil, err
			}
			events = append(events, abortEv...)
			return &abci.ExecTxResult{Code: 0, Events: events}, nil
		}

		// Advance out of shuffle now that shares are ready.
		dh.HoleSharesDeadline = 0
		if h.ActionOn == -1 {
			h.Phase = state.PhaseAwaitFlop
			h.ActionOn = -1
		} else {
			h.Phase = state.PhaseBetting
		}
		if err := setRevealDeadlineIfAwaiting(t, nowUnix); err != nil {
			return nil, err
		}
		events = append(events, abci.Event{
			Type: "HoleCardsReady",
			Attributes: []abci.EventAttribute{
				{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
				{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
				{Key: "phase", Value: string(h.Phase), Index: true},
			},
		})
		return &abci.ExecTxResult{Code: 0, Events: events}, nil
	}

	// ---- Reveal (Board / Showdown) ----
	pos, awaiting, err := dealerExpectedRevealPos(t)
	if err != nil {
		return nil, err
	}
	if !awaiting {
		return nil, fmt.Errorf("no dealer timeout applicable")
	}
	if dh.RevealPos != pos || dh.RevealDeadline == 0 {
		return nil, fmt.Errorf("reveal deadline not initialized")
	}
	if nowUnix < dh.RevealDeadline {
		return nil, fmt.Errorf("reveal not timed out")
	}

	missing := dealerMissingPubShares(epoch, dh, pos)
	for _, id := range missing {
		if epochSlash(epoch, id) {
			amt, err := jailAndSlashValidator(st, id, slashBpsHandDealer)
			if err != nil {
				return nil, err
			}
			events = append(events, abci.Event{
				Type: "ValidatorSlashed",
				Attributes: []abci.EventAttribute{
					{Key: "tableId", Value: fmt.Sprintf("%d", t.ID), Index: true},
					{Key: "handId", Value: fmt.Sprintf("%d", h.HandID), Index: true},
					{Key: "epochId", Value: fmt.Sprintf("%d", epoch.EpochID), Index: true},
					{Key: "validatorId", Value: id, Index: true},
					{Key: "reason", Value: "reveal-timeout", Index: false},
					{Key: "amount", Value: fmt.Sprintf("%d", amt), Index: false},
					{Key: "pos", Value: fmt.Sprintf("%d", pos), Index: true},
				},
			})
		}
	}

	if len(epochQualMembers(epoch)) < threshold {
		abortEv, err := abortHandRefundAllCommits(t, "dealer: committee below threshold after reveal timeout")
		if err != nil {
			return nil, err
		}
		events = append(events, abortEv...)
		return &abci.ExecTxResult{Code: 0, Events: events}, nil
	}

	fin, err := dealerFinalizeReveal(st, t, codec.DealerFinalizeRevealTx{TableID: t.ID, HandID: h.HandID, Pos: pos}, nowUnix)
	if err != nil {
		return nil, err
	}
	events = append(events, fin.Events...)
	return &abci.ExecTxResult{Code: 0, Events: events}, nil
}
