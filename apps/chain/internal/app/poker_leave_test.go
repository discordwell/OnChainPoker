package app

import (
	"testing"
)

func setupTableSinglePlayerWithBond(t *testing.T, bond uint64) (a *OCPApp, tableID uint64) {
	t.Helper()

	const height = int64(1)
	a = newTestApp(t)

	mintTestTokens(t, a, height, "alice", 1000)
	registerTestAccount(t, a, height, "alice")

	createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":    "alice",
		"smallBlind": 1,
		"bigBlind":   2,
		"minBuyIn":   100,
		"maxBuyIn":   1000,
		"playerBond": bond,
		"label":      "t",
	}, "alice"), height, 0))
	ev := findEvent(createRes.Events, "TableCreated")
	tableID = parseU64(t, attr(ev, "tableId"))
	return a, tableID
}

func TestSit_DepositsBondAndSetsSeatBond(t *testing.T) {
	const height = int64(1)
	a, tableID := setupTableSinglePlayerWithBond(t, 50)

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{
		"player":  "alice",
		"tableId": tableID,
		"seat":    0,
		"buyIn":   100,
	}, "alice"), height, 0))

	if bal := a.st.Balance("alice"); bal != 850 {
		t.Fatalf("expected alice bank=850 after buyIn(100)+bond(50) deposit, got %d", bal)
	}
	tbl := a.st.Tables[tableID]
	if tbl == nil || tbl.Seats[0] == nil {
		t.Fatalf("expected seat 0 occupied")
	}
	if tbl.Seats[0].Stack != 100 {
		t.Fatalf("expected seat stack=100, got %d", tbl.Seats[0].Stack)
	}
	if tbl.Seats[0].Bond != 50 {
		t.Fatalf("expected seat bond=50, got %d", tbl.Seats[0].Bond)
	}
}

func TestLeave_ReturnsStackAndBondAndFreesSeat(t *testing.T) {
	const height = int64(1)
	a, tableID := setupTableSinglePlayerWithBond(t, 50)

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{
		"player":  "alice",
		"tableId": tableID,
		"seat":    0,
		"buyIn":   100,
	}, "alice"), height, 0))

	res := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/leave", map[string]any{
		"player":  "alice",
		"tableId": tableID,
	}, "alice"), height, 0))
	if findEvent(res.Events, "PlayerLeft") == nil {
		t.Fatalf("expected PlayerLeft event")
	}

	if bal := a.st.Balance("alice"); bal != 1000 {
		t.Fatalf("expected alice bank restored to 1000 after leaving, got %d", bal)
	}
	tbl := a.st.Tables[tableID]
	if tbl == nil {
		t.Fatalf("expected table")
	}
	if tbl.Seats[0] != nil {
		t.Fatalf("expected seat 0 cleared after leave")
	}
}

func TestLeave_DisallowedDuringActiveHandIfInHand(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTable(t)

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{
		"caller":  "alice",
		"tableId": tableID,
	}, "alice"), height, 0))

	res := a.deliverTx(txBytesSigned(t, "poker/leave", map[string]any{
		"player":  "alice",
		"tableId": tableID,
	}, "alice"), height, 0)
	if res.Code == 0 {
		t.Fatalf("expected leave rejected during active hand")
	}
}

func setupHeadsUpTableWithBondAndActionTimeout(t *testing.T, bond uint64, actionTO uint64) (a *OCPApp, tableID uint64) {
	t.Helper()

	const height = int64(1)
	a = newTestApp(t)

	mintTestTokens(t, a, height, "alice", 1000)
	mintTestTokens(t, a, height, "bob", 1000)
	registerTestAccount(t, a, height, "alice")
	registerTestAccount(t, a, height, "bob")

	createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":           "alice",
		"smallBlind":        1,
		"bigBlind":          2,
		"minBuyIn":          100,
		"maxBuyIn":          1000,
		"actionTimeoutSecs": actionTO,
		"playerBond":        bond,
		"label":             "t",
	}, "alice"), height, 0))
	ev := findEvent(createRes.Events, "TableCreated")
	tableID = parseU64(t, attr(ev, "tableId"))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 100}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 100}, "bob"), height, 0))

	return a, tableID
}

func TestPokerTick_SlashesBondAndEjectsWhenDepletedBetweenHands(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTableWithBondAndActionTimeout(t, 1, 10)

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{
		"caller":  "alice",
		"tableId": tableID,
	}, "alice"), height, 0))

	// At/after deadline: SB times out facing a bet -> fold. Bond is 1 and slash is 2 (BB), so bond is depleted.
	res := mustOk(t, a.deliverTx(txBytes(t, "poker/tick", map[string]any{"tableId": tableID}), height, 10))
	if findEvent(res.Events, "TimeoutApplied") == nil {
		t.Fatalf("expected TimeoutApplied event")
	}
	slashEv := findEvent(res.Events, "PlayerSlashed")
	if slashEv == nil {
		t.Fatalf("expected PlayerSlashed event")
	}
	if got := attr(slashEv, "amount"); got != "1" {
		t.Fatalf("expected slash amount=1, got %q", got)
	}
	if findEvent(res.Events, "HandCompleted") == nil {
		t.Fatalf("expected HandCompleted event")
	}
	if findEvent(res.Events, "PlayerEjected") == nil {
		t.Fatalf("expected PlayerEjected event")
	}

	// Alice loses SB (1) + bond (1), and the remaining stack is returned to her bank via ejection.
	if bal := a.st.Balance("alice"); bal != 998 {
		t.Fatalf("expected alice bank=998 after losing 2 total, got %d", bal)
	}

	tbl := a.st.Tables[tableID]
	if tbl == nil {
		t.Fatalf("expected table")
	}
	if tbl.Seats[0] != nil {
		t.Fatalf("expected alice seat ejected")
	}
	if tbl.Seats[1] == nil {
		t.Fatalf("expected bob still seated")
	}
	if tbl.Seats[1].Stack != 101 {
		t.Fatalf("expected bob stack=101 after winning blinds, got %d", tbl.Seats[1].Stack)
	}
}
