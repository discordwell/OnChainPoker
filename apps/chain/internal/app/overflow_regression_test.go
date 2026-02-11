package app

import (
	"math"
	"testing"
)

func TestOverflow_BankSendCreditOverflowRollsBackDebit(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	registerTestAccount(t, a, height, "alice")
	registerTestAccount(t, a, height, "bob")

	a.st.Accounts["alice"] = 100
	a.st.Accounts["bob"] = ^uint64(0)

	res := a.deliverTx(txBytesSigned(t, "bank/send", map[string]any{
		"from":   "alice",
		"to":     "bob",
		"amount": uint64(1),
	}, "alice"), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected overflow failure")
	}
	if got := a.st.Balance("alice"); got != 100 {
		t.Fatalf("alice balance mutated on failed overflow send: %d", got)
	}
	if got := a.st.Balance("bob"); got != ^uint64(0) {
		t.Fatalf("bob balance mutated on failed overflow send: %d", got)
	}
}

func TestOverflow_StakingBondOverflowDoesNotMutateState(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	pub, _ := testEd25519Key("v1")
	mintTestTokens(t, a, height, "v1", 10)
	mustOk(t, a.deliverTx(txBytesSigned(t, "staking/register_validator", map[string]any{
		"validatorId": "v1",
		"pubKey":      []byte(pub),
	}, "v1"), height, 0))

	v := findValidator(a.st, "v1")
	if v == nil {
		t.Fatalf("missing validator v1")
	}
	v.Bond = ^uint64(0)
	beforeBal := a.st.Balance("v1")

	res := a.deliverTx(txBytesSigned(t, "staking/bond", map[string]any{
		"validatorId": "v1",
		"amount":      uint64(1),
	}, "v1"), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected overflow failure")
	}

	if got := a.st.Balance("v1"); got != beforeBal {
		t.Fatalf("validator balance mutated on failed bond overflow: %d", got)
	}
	v = findValidator(a.st, "v1")
	if v == nil {
		t.Fatalf("missing validator v1 after failed tx")
	}
	if v.Bond != ^uint64(0) {
		t.Fatalf("validator bond mutated on failed overflow: %d", v.Bond)
	}
}

func TestOverflow_PokerLeaveCreditOverflowDoesNotUnseat(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	mintTestTokens(t, a, height, "alice", 1000)
	registerTestAccount(t, a, height, "alice")

	createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":    "alice",
		"smallBlind": 1,
		"bigBlind":   2,
		"minBuyIn":   1,
		"maxBuyIn":   1000,
	}, "alice"), height, 0))
	tableID := parseU64(t, attr(findEvent(createRes.Events, "TableCreated"), "tableId"))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{
		"player":  "alice",
		"tableId": tableID,
		"seat":    0,
		"buyIn":   1,
	}, "alice"), height, 0))

	a.st.Accounts["alice"] = ^uint64(0)

	res := a.deliverTx(txBytesSigned(t, "poker/leave", map[string]any{
		"player":  "alice",
		"tableId": tableID,
	}, "alice"), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected overflow failure")
	}
	if got := a.st.Balance("alice"); got != ^uint64(0) {
		t.Fatalf("alice balance mutated on failed leave overflow: %d", got)
	}
	if a.st.Tables[tableID].Seats[0] == nil {
		t.Fatalf("seat should remain occupied on failed leave")
	}
}

func TestOverflow_ComputeSidePotsRejectsOverflow(t *testing.T) {
	var total [9]uint64
	var eligible [9]bool

	total[0] = ^uint64(0)
	total[1] = ^uint64(0)
	eligible[0] = true
	eligible[1] = true

	if _, err := computeSidePots(total, eligible); err == nil {
		t.Fatalf("expected side-pot overflow error")
	}
}

func TestOverflow_PokerCreateTableNextTableID(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	mintTestTokens(t, a, height, "alice", 1000)
	registerTestAccount(t, a, height, "alice")

	a.st.NextTableID = ^uint64(0)

	res := a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":    "alice",
		"smallBlind": uint64(1),
		"bigBlind":   uint64(2),
		"minBuyIn":   uint64(1),
		"maxBuyIn":   uint64(1000),
	}, "alice"), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected next table id overflow failure")
	}
	if a.st.NextTableID != ^uint64(0) {
		t.Fatalf("next table id mutated on overflow: %d", a.st.NextTableID)
	}
	if len(a.st.Tables) != 0 {
		t.Fatalf("table created despite next table id overflow")
	}
}

func TestOverflow_PokerStartHandNextHandID(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTable(t)

	tbl := a.st.Tables[tableID]
	if tbl == nil {
		t.Fatalf("missing table")
	}
	tbl.NextHandID = ^uint64(0)

	res := a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{
		"caller":  "alice",
		"tableId": tableID,
	}, "alice"), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected next hand id overflow failure")
	}
	if tbl.NextHandID != ^uint64(0) {
		t.Fatalf("next hand id mutated on overflow: %d", tbl.NextHandID)
	}
	if tbl.Hand != nil {
		t.Fatalf("hand started despite next hand id overflow")
	}
}

func TestOverflow_PokerStartHandHugeActionTimeout(t *testing.T) {
	const height = int64(1)
	a := newTestApp(t)

	mintTestTokens(t, a, height, "alice", 1000)
	mintTestTokens(t, a, height, "bob", 1000)
	registerTestAccount(t, a, height, "alice")
	registerTestAccount(t, a, height, "bob")

	createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":           "alice",
		"smallBlind":        uint64(1),
		"bigBlind":          uint64(2),
		"minBuyIn":          uint64(1),
		"maxBuyIn":          uint64(1000),
		"actionTimeoutSecs": ^uint64(0),
	}, "alice"), height, 0))
	tableID := parseU64(t, attr(findEvent(createRes.Events, "TableCreated"), "tableId"))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{
		"player":  "alice",
		"tableId": tableID,
		"seat":    0,
		"buyIn":   uint64(100),
	}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{
		"player":  "bob",
		"tableId": tableID,
		"seat":    1,
		"buyIn":   uint64(100),
	}, "bob"), height, 0))

	tblBefore := a.st.Tables[tableID]
	nextBefore := tblBefore.NextHandID
	res := a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{
		"caller":  "alice",
		"tableId": tableID,
	}, "alice"), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected huge action timeout overflow failure")
	}
	tblAfter := a.st.Tables[tableID]
	if tblAfter.Hand != nil {
		t.Fatalf("hand started despite huge action timeout overflow")
	}
	if tblAfter.NextHandID != nextBefore {
		t.Fatalf("next hand id mutated on huge timeout failure: got %d want %d", tblAfter.NextHandID, nextBefore)
	}
}

func TestOverflow_DealerBeginEpochHugeBlockHeight(t *testing.T) {
	a := newTestApp(t)

	pub, _ := testEd25519Key("v1")
	mintTestTokens(t, a, 1, "v1", 1000)
	mustOk(t, a.deliverTx(txBytesSigned(t, "staking/register_validator", map[string]any{
		"validatorId": "v1",
		"pubKey":      []byte(pub),
	}, "v1"), 1, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "staking/bond", map[string]any{
		"validatorId": "v1",
		"amount":      uint64(100),
	}, "v1"), 1, 0))

	res := a.deliverTx(txBytes(t, "dealer/begin_epoch", map[string]any{
		"epochId":         uint64(1),
		"committeeSize":   uint32(1),
		"threshold":       uint8(1),
		"commitBlocks":    uint64(1),
		"complaintBlocks": uint64(1),
		"revealBlocks":    uint64(1),
		"finalizeBlocks":  uint64(1),
	}), math.MaxInt64, 0)
	if res.Code == 0 {
		t.Fatalf("expected dkg commit deadline overflow failure")
	}
	if a.st.Dealer.NextEpochID != 1 {
		t.Fatalf("next epoch advanced on huge height overflow: %d", a.st.Dealer.NextEpochID)
	}
	if a.st.Dealer.DKG != nil {
		t.Fatalf("dkg set despite huge height overflow")
	}
}

func TestOverflow_DealerBeginEpochNextEpochID(t *testing.T) {
	a := newTestApp(t)
	if a.st.Dealer == nil {
		t.Fatalf("missing dealer state")
	}
	a.st.Dealer.NextEpochID = ^uint64(0)

	res := a.deliverTx(txBytes(t, "dealer/begin_epoch", map[string]any{
		"epochId":       ^uint64(0),
		"committeeSize": uint32(1),
		"threshold":     uint8(1),
	}), 1, 0)
	if res.Code == 0 {
		t.Fatalf("expected next epoch id overflow failure")
	}
	if a.st.Dealer.NextEpochID != ^uint64(0) {
		t.Fatalf("next epoch id mutated on overflow: %d", a.st.Dealer.NextEpochID)
	}
	if a.st.Dealer.DKG != nil {
		t.Fatalf("dkg set despite next epoch id overflow")
	}
}
