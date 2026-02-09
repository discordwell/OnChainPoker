package app

import (
	"bytes"
	"encoding/binary"
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
	if msg.EpochID == 0 {
		return nil, fmt.Errorf("epochId must be > 0")
	}
	if msg.Threshold == 0 {
		return nil, fmt.Errorf("threshold must be > 0")
	}
	if len(msg.PKEpoch) != ocpcrypto.PointBytes {
		return nil, fmt.Errorf("pkEpoch must be 32 bytes")
	}
	if _, err := ocpcrypto.PointFromBytesCanonical(msg.PKEpoch); err != nil {
		return nil, fmt.Errorf("pkEpoch invalid: %w", err)
	}
	if len(msg.Members) == 0 {
		return nil, fmt.Errorf("members must be non-empty")
	}
	if int(msg.Threshold) > len(msg.Members) {
		return nil, fmt.Errorf("threshold exceeds members length")
	}

	seenID := map[string]bool{}
	seenIdx := map[uint32]bool{}

	members := make([]state.DealerMember, 0, len(msg.Members))
	for _, m := range msg.Members {
		if m.ValidatorID == "" {
			return nil, fmt.Errorf("member missing validatorId")
		}
		if seenID[m.ValidatorID] {
			return nil, fmt.Errorf("duplicate validatorId %q", m.ValidatorID)
		}
		seenID[m.ValidatorID] = true
		if m.Index == 0 {
			return nil, fmt.Errorf("member %q index must be non-zero", m.ValidatorID)
		}
		if seenIdx[m.Index] {
			return nil, fmt.Errorf("duplicate member index %d", m.Index)
		}
		seenIdx[m.Index] = true
		if len(m.PubShare) != ocpcrypto.PointBytes {
			return nil, fmt.Errorf("member %q pubShare must be 32 bytes", m.ValidatorID)
		}
		if _, err := ocpcrypto.PointFromBytesCanonical(m.PubShare); err != nil {
			return nil, fmt.Errorf("member %q pubShare invalid: %w", m.ValidatorID, err)
		}
		members = append(members, state.DealerMember{
			ValidatorID: m.ValidatorID,
			Index:       m.Index,
			PubShare:    append([]byte(nil), m.PubShare...),
		})
	}

	// Canonicalize member ordering for deterministic state.
	sort.Slice(members, func(i, j int) bool {
		if members[i].ValidatorID != members[j].ValidatorID {
			return members[i].ValidatorID < members[j].ValidatorID
		}
		return members[i].Index < members[j].Index
	})

	st.Dealer.Epoch = &state.DealerEpoch{
		EpochID:   msg.EpochID,
		Threshold: msg.Threshold,
		PKEpoch:   append([]byte(nil), msg.PKEpoch...),
		Members:   members,
	}

	ev := okEvent("DealerEpochBegun", map[string]string{
		"epochId":   fmt.Sprintf("%d", msg.EpochID),
		"threshold": fmt.Sprintf("%d", msg.Threshold),
		"members":   fmt.Sprintf("%d", len(members)),
	})
	return ev, nil
}

func dealerInitHand(st *state.State, t *state.Table, msg codec.DealerInitHandTx) (*abci.ExecTxResult, error) {
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

	h.Dealer = &state.DealerHand{
		EpochID: epoch.EpochID,
		PKHand:  append([]byte(nil), pkHand.Bytes()...),
		DeckSize: deckSize,
		Deck:    deck,
	}

	ev := okEvent("DealerHandInitialized", map[string]string{
		"tableId":  fmt.Sprintf("%d", t.ID),
		"handId":   fmt.Sprintf("%d", h.HandID),
		"epochId":  fmt.Sprintf("%d", epoch.EpochID),
		"deckSize": fmt.Sprintf("%d", deckSize),
	})
	return ev, nil
}

func dealerSubmitShuffle(t *state.Table, msg codec.DealerSubmitShuffleTx) (*abci.ExecTxResult, error) {
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
	if msg.Round != dh.ShuffleStep+1 {
		return nil, fmt.Errorf("round mismatch: expected %d got %d", dh.ShuffleStep+1, msg.Round)
	}
	if msg.ShufflerID == "" {
		return nil, fmt.Errorf("missing shufflerId")
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

	ev := okEvent("ShuffleAccepted", map[string]string{
		"tableId":    fmt.Sprintf("%d", t.ID),
		"handId":     fmt.Sprintf("%d", h.HandID),
		"round":      fmt.Sprintf("%d", msg.Round),
		"shufflerId": msg.ShufflerID,
	})
	return ev, nil
}

func dealerFinalizeDeck(t *state.Table, msg codec.DealerFinalizeDeckTx) (*abci.ExecTxResult, error) {
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

func dealerSubmitPubShare(st *state.State, t *state.Table, msg codec.DealerSubmitPubShareTx) (*abci.ExecTxResult, error) {
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

func dealerSubmitEncShare(st *state.State, t *state.Table, msg codec.DealerSubmitEncShareTx) (*abci.ExecTxResult, error) {
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
			if h.ActionOn == -1 {
				h.Phase = state.PhaseAwaitFlop
				h.ActionOn = -1
			} else {
				h.Phase = state.PhaseBetting
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

func dealerFinalizeReveal(st *state.State, t *state.Table, msg codec.DealerFinalizeRevealTx) (*abci.ExecTxResult, error) {
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
	if int(msg.Pos) >= len(dh.Deck) {
		return nil, fmt.Errorf("pos out of bounds")
	}
	epoch := st.Dealer.Epoch
	if epoch == nil || epoch.EpochID != dh.EpochID {
		return nil, fmt.Errorf("epoch not available")
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
	extra, err := applyDealerRevealToPoker(t, msg.Pos, cardID)
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
