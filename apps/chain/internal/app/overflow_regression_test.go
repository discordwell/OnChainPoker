package app

import "testing"

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
