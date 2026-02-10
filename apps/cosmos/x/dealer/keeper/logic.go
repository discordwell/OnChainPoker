package keeper

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"

	sdkmath "cosmossdk.io/math"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
	"onchainpoker/apps/cosmos/internal/ocpshuffle"
	dealercommittee "onchainpoker/apps/cosmos/x/dealer/committee"
	"onchainpoker/apps/cosmos/x/dealer/types"
	pokertypes "onchainpoker/apps/cosmos/x/poker/types"
)

const (
	handDeriveDomain = "ocp/v1/dealer/hand-derive"
	deckInitDomain   = "ocp/v1/dealer/deck-init"

	dkgTranscriptDomain = "ocp/v1/dkg/transcript"

	dkgShareMsgMagicV1  = "OCP1"
	dkgShareMsgDomainV1 = "ocp/dkg/sharemsg/v1"
)

const (
	// v0 localnet defaults (measured in blocks).
	dkgCommitBlocksDefault    uint64 = 5
	dkgComplaintBlocksDefault uint64 = 5
	dkgRevealBlocksDefault    uint64 = 5
	dkgFinalizeBlocksDefault  uint64 = 5
)

func bpsToDec(bps uint32) sdkmath.LegacyDec {
	// bps / 10_000
	return sdkmath.LegacyNewDec(int64(bps)).QuoInt64(10000)
}

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

func pointToCardID(p ocpcrypto.Point, deckSize int) (uint32, error) {
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

// ---- DKG share-msg v1 ----

type dkgShareMsgV1 struct {
	EpochID uint64
	Dealer  string
	To      string
	Share   []byte // 32 bytes scalar
	Sig     []byte // 64 bytes ed25519 signature
	Body    []byte // signed payload prefix (everything up to, but excluding, Sig)
}

func decodeDKGShareMsgV1(b []byte) (*dkgShareMsgV1, error) {
	// Encoding:
	//   magic(4) || epochId(u64le) || dealerLen(u16le) || dealer || toLen(u16le) || to || share(32) || sig(64)
	min := 4 + 8 + 2 + 2 + 32 + 64
	if len(b) < min {
		return nil, fmt.Errorf("shareMsg too short")
	}
	if string(b[:4]) != dkgShareMsgMagicV1 {
		return nil, fmt.Errorf("shareMsg bad magic")
	}
	off := 4
	epochID := binary.LittleEndian.Uint64(b[off : off+8])
	off += 8

	dealerLen := int(binary.LittleEndian.Uint16(b[off : off+2]))
	off += 2
	if dealerLen <= 0 || off+dealerLen+2 > len(b) {
		return nil, fmt.Errorf("shareMsg bad dealer length")
	}
	dealer := string(b[off : off+dealerLen])
	off += dealerLen

	toLen := int(binary.LittleEndian.Uint16(b[off : off+2]))
	off += 2
	if toLen <= 0 || off+toLen+32+64 > len(b) {
		return nil, fmt.Errorf("shareMsg bad to length")
	}
	to := string(b[off : off+toLen])
	off += toLen

	share := append([]byte(nil), b[off:off+32]...)
	off += 32
	sig := append([]byte(nil), b[off:off+64]...)
	off += 64

	if off != len(b) {
		return nil, fmt.Errorf("shareMsg trailing bytes")
	}

	return &dkgShareMsgV1{
		EpochID: epochID,
		Dealer:  dealer,
		To:      to,
		Share:   share,
		Sig:     sig,
		Body:    append([]byte(nil), b[:len(b)-64]...),
	}, nil
}

// ---- DKG verification ----

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

// ---- Helpers over protobuf state ----

func findDKGMember(dkg *types.DealerDKG, valoper string) *types.DealerMember {
	if dkg == nil || valoper == "" {
		return nil
	}
	for i := range dkg.Members {
		if dkg.Members[i].Validator == valoper {
			return &dkg.Members[i]
		}
	}
	return nil
}

func findDKGCommit(dkg *types.DealerDKG, dealer string) *types.DealerDKGCommit {
	if dkg == nil || dealer == "" {
		return nil
	}
	for i := range dkg.Commits {
		if dkg.Commits[i].Dealer == dealer {
			return &dkg.Commits[i]
		}
	}
	return nil
}

func findDKGComplaint(dkg *types.DealerDKG, complainer, dealer string) *types.DealerDKGComplaint {
	if dkg == nil || complainer == "" || dealer == "" {
		return nil
	}
	for i := range dkg.Complaints {
		c := &dkg.Complaints[i]
		if c.Complainer == complainer && c.Dealer == dealer {
			return c
		}
	}
	return nil
}

func findDKGReveal(dkg *types.DealerDKG, dealer, to string) *types.DealerDKGShareReveal {
	if dkg == nil || dealer == "" || to == "" {
		return nil
	}
	for i := range dkg.Reveals {
		r := &dkg.Reveals[i]
		if r.Dealer == dealer && r.To == to {
			return r
		}
	}
	return nil
}

func dkgIsSlashed(dkg *types.DealerDKG, valoper string) bool {
	if dkg == nil || valoper == "" || len(dkg.Slashed) == 0 {
		return false
	}
	i := sort.SearchStrings(dkg.Slashed, valoper)
	return i < len(dkg.Slashed) && dkg.Slashed[i] == valoper
}

func dkgSlash(dkg *types.DealerDKG, valoper string) bool {
	if dkg == nil || valoper == "" {
		return false
	}
	if dkgIsSlashed(dkg, valoper) {
		return false
	}
	i := sort.SearchStrings(dkg.Slashed, valoper)
	dkg.Slashed = append(dkg.Slashed, "")
	copy(dkg.Slashed[i+1:], dkg.Slashed[i:])
	dkg.Slashed[i] = valoper
	return true
}

func findEpochMember(epoch *types.DealerEpoch, valoper string) *types.DealerMember {
	if epoch == nil || valoper == "" {
		return nil
	}
	for i := range epoch.Members {
		if epoch.Members[i].Validator == valoper {
			return &epoch.Members[i]
		}
	}
	return nil
}

func epochIsSlashed(epoch *types.DealerEpoch, valoper string) bool {
	if epoch == nil || valoper == "" || len(epoch.Slashed) == 0 {
		return false
	}
	i := sort.SearchStrings(epoch.Slashed, valoper)
	return i < len(epoch.Slashed) && epoch.Slashed[i] == valoper
}

func epochSlash(epoch *types.DealerEpoch, valoper string) bool {
	if epoch == nil || valoper == "" {
		return false
	}
	if epochIsSlashed(epoch, valoper) {
		return false
	}
	i := sort.SearchStrings(epoch.Slashed, valoper)
	epoch.Slashed = append(epoch.Slashed, "")
	copy(epoch.Slashed[i+1:], epoch.Slashed[i:])
	epoch.Slashed[i] = valoper
	return true
}

func epochQualMembers(epoch *types.DealerEpoch) []types.DealerMember {
	if epoch == nil {
		return nil
	}
	out := make([]types.DealerMember, 0, len(epoch.Members))
	for _, m := range epoch.Members {
		if epochIsSlashed(epoch, m.Validator) {
			continue
		}
		out = append(out, m)
	}
	return out
}

// ---- Transcript root ----

func dkgTranscriptRoot(dkg *types.DealerDKG) ([]byte, error) {
	if dkg == nil {
		return nil, fmt.Errorf("dkg is nil")
	}
	view := struct {
		EpochID           uint64                       `json:"epochId"`
		Threshold         uint32                       `json:"threshold"`
		Members           []types.DealerMember         `json:"members"`
		StartHeight       int64                        `json:"startHeight"`
		CommitDeadline    int64                        `json:"commitDeadline"`
		ComplaintDeadline int64                        `json:"complaintDeadline"`
		RevealDeadline    int64                        `json:"revealDeadline"`
		FinalizeDeadline  int64                        `json:"finalizeDeadline"`
		RandEpoch         []byte                       `json:"randEpoch,omitempty"`
		Commits           []types.DealerDKGCommit      `json:"commits,omitempty"`
		Complaints        []types.DealerDKGComplaint   `json:"complaints,omitempty"`
		Reveals           []types.DealerDKGShareReveal `json:"reveals,omitempty"`
		Slashed           []string                     `json:"slashed,omitempty"`
	}{
		EpochID:           dkg.EpochId,
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
	}
	b, err := json.Marshal(view)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(append([]byte(dkgTranscriptDomain), b...))
	return sum[:], nil
}

// ---- Hand helpers ----

func tableDealerTimeoutSecs(t *pokertypes.Table) uint64 {
	if t == nil {
		return 120
	}
	if t.Params.DealerTimeoutSecs == 0 {
		return 120
	}
	return t.Params.DealerTimeoutSecs
}

func holeDealOrder(t *pokertypes.Table) []int {
	if t == nil || t.Hand == nil {
		return nil
	}
	h := t.Hand
	start := int(h.SmallBlindSeat)
	if start < 0 || start >= 9 {
		start = 0
	}
	order := []int{}
	cur := start
	for {
		if cur >= 0 && cur < len(h.InHand) && h.InHand[cur] {
			order = append(order, cur)
		}
		cur = (cur + 1) % 9
		if cur == start {
			break
		}
	}
	return order
}

func dealerMissingPubShares(epoch *types.DealerEpoch, dh *types.DealerHand, pos uint32) []string {
	if epoch == nil || dh == nil {
		return nil
	}
	have := map[string]bool{}
	for _, ps := range dh.PubShares {
		if ps.Pos != pos {
			continue
		}
		have[ps.Validator] = true
	}

	missing := []string{}
	for _, m := range epochQualMembers(epoch) {
		if have[m.Validator] {
			continue
		}
		missing = append(missing, m.Validator)
	}
	sort.Strings(missing)
	return missing
}

func dealerMissingHoleEncShares(epoch *types.DealerEpoch, t *pokertypes.Table, dh *types.DealerHand) ([]string, error) {
	if epoch == nil || t == nil || t.Hand == nil || t.Hand.Dealer == nil || dh == nil {
		return nil, fmt.Errorf("missing dealer hand")
	}
	h := t.Hand
	meta := h.Dealer
	if len(meta.HolePos) != 18 {
		return nil, fmt.Errorf("hole_pos not initialized")
	}

	required := make([]uint32, 0, 18)
	for seat := 0; seat < 9; seat++ {
		if seat >= len(h.InHand) || !h.InHand[seat] {
			continue
		}
		for c := 0; c < 2; c++ {
			pos := meta.HolePos[seat*2+c]
			if pos == 255 {
				return nil, fmt.Errorf("hole_pos unset for seat %d", seat)
			}
			required = append(required, pos)
		}
	}

	have := map[string]map[uint32]bool{}
	for _, es := range dh.EncShares {
		m := have[es.Validator]
		if m == nil {
			m = map[uint32]bool{}
			have[es.Validator] = m
		}
		m[es.Pos] = true
	}

	missing := []string{}
	for _, m := range epochQualMembers(epoch) {
		id := m.Validator
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

func dealerHoleEncSharesReady(epoch *types.DealerEpoch, t *pokertypes.Table, dh *types.DealerHand) (bool, error) {
	if epoch == nil || t == nil || t.Hand == nil || t.Hand.Dealer == nil || dh == nil {
		return false, nil
	}
	h := t.Hand
	meta := h.Dealer
	if !meta.DeckFinalized || len(meta.HolePos) != 18 {
		return false, nil
	}
	tNeed := int(epoch.Threshold)
	if tNeed <= 0 {
		return false, fmt.Errorf("invalid threshold")
	}

	for seat := 0; seat < 9; seat++ {
		if seat >= len(h.InHand) || !h.InHand[seat] {
			continue
		}
		s := t.Seats[seat]
		if s == nil || len(s.Pk) != ocpcrypto.PointBytes {
			return false, fmt.Errorf("seat %d missing pk", seat)
		}
		for c := 0; c < 2; c++ {
			pos := meta.HolePos[seat*2+c]
			if pos == 255 {
				return false, fmt.Errorf("hole_pos unset for seat %d", seat)
			}
			n := 0
			for _, es := range dh.EncShares {
				if es.Pos != pos {
					continue
				}
				if bytes.Equal(es.PkPlayer, s.Pk) {
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

func isHolePos(meta *pokertypes.DealerMeta, h *pokertypes.Hand, pos uint32) (seat int, ok bool) {
	if meta == nil || h == nil || len(meta.HolePos) != 18 {
		return -1, false
	}
	for s := 0; s < 9; s++ {
		if s >= len(h.InHand) || !h.InHand[s] {
			continue
		}
		if meta.HolePos[s*2] == pos || meta.HolePos[s*2+1] == pos {
			return s, true
		}
	}
	return -1, false
}

// ---- Shuffle verification ----

func verifyShuffle(pkHandBytes []byte, deckIn []types.DealerCiphertext, proofBytes []byte) ([]types.DealerCiphertext, string, error) {
	pkHand, err := ocpcrypto.PointFromBytesCanonical(pkHandBytes)
	if err != nil {
		return nil, "", fmt.Errorf("pkHand invalid: %w", err)
	}

	in := make([]ocpcrypto.ElGamalCiphertext, 0, len(deckIn))
	for _, c := range deckIn {
		c1, err := ocpcrypto.PointFromBytesCanonical(c.C1)
		if err != nil {
			return nil, "", fmt.Errorf("deck c1 invalid: %w", err)
		}
		c2, err := ocpcrypto.PointFromBytesCanonical(c.C2)
		if err != nil {
			return nil, "", fmt.Errorf("deck c2 invalid: %w", err)
		}
		in = append(in, ocpcrypto.ElGamalCiphertext{C1: c1, C2: c2})
	}

	vr := ocpshuffle.ShuffleVerifyV1(pkHand, in, proofBytes)
	if !vr.OK {
		return nil, "", fmt.Errorf("shuffle verify failed: %s", vr.Error)
	}

	out := make([]types.DealerCiphertext, 0, len(vr.DeckOut))
	for _, ct := range vr.DeckOut {
		out = append(out, types.DealerCiphertext{
			C1: append([]byte(nil), ct.C1.Bytes()...),
			C2: append([]byte(nil), ct.C2.Bytes()...),
		})
	}

	sum := sha256.Sum256(proofBytes)
	return out, hex.EncodeToString(sum[:]), nil
}

// ---- DKG share-msg signature verification ----

func verifyShareMsgSig(consPubkey []byte, shareMsg *dkgShareMsgV1) bool {
	if len(consPubkey) != ed25519.PublicKeySize || shareMsg == nil {
		return false
	}
	sigMsg := append(append([]byte(dkgShareMsgDomainV1), 0), shareMsg.Body...)
	return ed25519.Verify(ed25519.PublicKey(consPubkey), sigMsg, shareMsg.Sig)
}

// ---- Committee sampling ----

func sampleMembers(ctx context.Context, stakingKeeper dealercommittee.StakingKeeper, epochID uint64, randEpoch []byte, k int) ([]types.DealerMember, [32]byte, error) {
	re, err := dealercommittee.RandEpochOrDevnet(ctx, epochID, randEpoch)
	if err != nil {
		return nil, [32]byte{}, err
	}
	seed := dealercommittee.CommitteeSeed(re, epochID)
	snaps, err := dealercommittee.SampleBondedMemberSnapshotsByPower(ctx, stakingKeeper, seed, k)
	if err != nil {
		return nil, [32]byte{}, err
	}
	members, err := dealercommittee.DealerMembersFromSnapshots(snaps)
	if err != nil {
		return nil, [32]byte{}, err
	}
	return members, re, nil
}
