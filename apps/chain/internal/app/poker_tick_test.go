package app

import (
	"testing"
)

func setupHeadsUpTableWithActionTimeout(t *testing.T, actionTimeoutSecs uint64) (a *OCPApp, tableID uint64) {
	t.Helper()

	const height = int64(1)
	a = newTestApp(t)

	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "alice", "amount": 1000}), height, 0))
	mustOk(t, a.deliverTx(txBytes(t, "bank/mint", map[string]any{"to": "bob", "amount": 1000}), height, 0))
	registerTestAccount(t, a, height, "alice")
	registerTestAccount(t, a, height, "bob")

	createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
		"creator":           "alice",
		"smallBlind":        1,
		"bigBlind":          2,
		"minBuyIn":          100,
		"maxBuyIn":          1000,
		"actionTimeoutSecs": actionTimeoutSecs,
		"label":             "t",
	}, "alice"), height, 0))
	ev := findEvent(createRes.Events, "TableCreated")
	tableID = parseU64(t, attr(ev, "tableId"))

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "alice", "tableId": tableID, "seat": 0, "buyIn": 100}, "alice"), height, 0))
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{"player": "bob", "tableId": tableID, "seat": 1, "buyIn": 100}, "bob"), height, 0))

	return a, tableID
}

func TestPokerTick_AppliesFoldOnTimeoutWhenFacingBet(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTableWithActionTimeout(t, 10)

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}, "alice"), height, 0))

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("expected active hand")
	}
	if table.Hand.ActionDeadline != 10 {
		t.Fatalf("expected actionDeadline=10, got %d", table.Hand.ActionDeadline)
	}

	// Before deadline: should not apply.
	res := a.deliverTx(txBytes(t, "poker/tick", map[string]any{"tableId": tableID}), height, 9)
	if res.Code == 0 {
		t.Fatalf("expected error before deadline")
	}

	// At/after deadline: SB is facing a bet, so default is fold.
	res = mustOk(t, a.deliverTx(txBytes(t, "poker/tick", map[string]any{"tableId": tableID}), height, 10))
	timeoutEv := findEvent(res.Events, "TimeoutApplied")
	if timeoutEv == nil {
		t.Fatalf("expected TimeoutApplied event")
	}
	if got := attr(timeoutEv, "seat"); got != "0" {
		t.Fatalf("expected seat=0, got %q", got)
	}
	if got := attr(timeoutEv, "action"); got != "fold" {
		t.Fatalf("expected action=fold, got %q", got)
	}
	if findEvent(res.Events, "HandCompleted") == nil {
		t.Fatalf("expected HandCompleted event")
	}

	// Hand should be cleared and BB should win the pot.
	if table.Hand != nil {
		t.Fatalf("expected hand cleared")
	}
	if table.Seats[0] == nil || table.Seats[1] == nil {
		t.Fatalf("expected two seats")
	}
	if table.Seats[0].Stack != 99 {
		t.Fatalf("expected alice stack=99 after timing out and folding, got %d", table.Seats[0].Stack)
	}
	if table.Seats[1].Stack != 101 {
		t.Fatalf("expected bob stack=101 after winning blinds, got %d", table.Seats[1].Stack)
	}
}

func TestPokerTick_AppliesCheckOnTimeoutWhenCheckLegal(t *testing.T) {
	const height = int64(1)
	a, tableID := setupHeadsUpTableWithActionTimeout(t, 10)

	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{"caller": "alice", "tableId": tableID}, "alice"), height, 0))
	// SB calls quickly.
	mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{"player": "alice", "tableId": tableID, "action": "call"}, "alice"), height, 0))

	table := a.st.Tables[tableID]
	if table == nil || table.Hand == nil {
		t.Fatalf("expected active hand")
	}
	if table.Hand.ActionOn != 1 {
		t.Fatalf("expected actionOn=1 (BB), got %d", table.Hand.ActionOn)
	}
	if table.Hand.ActionDeadline != 10 {
		t.Fatalf("expected actionDeadline=10, got %d", table.Hand.ActionDeadline)
	}

	// At/after deadline: BB is facing 0, so default is check -> flop reveal.
	res := mustOk(t, a.deliverTx(txBytes(t, "poker/tick", map[string]any{"tableId": tableID}), height, 10))
	timeoutEv := findEvent(res.Events, "TimeoutApplied")
	if timeoutEv == nil {
		t.Fatalf("expected TimeoutApplied event")
	}
	if got := attr(timeoutEv, "seat"); got != "1" {
		t.Fatalf("expected seat=1, got %q", got)
	}
	if got := attr(timeoutEv, "action"); got != "check" {
		t.Fatalf("expected action=check, got %q", got)
	}
	if findEvent(res.Events, "StreetRevealed") == nil {
		t.Fatalf("expected StreetRevealed event")
	}

	if table.Hand == nil {
		t.Fatalf("expected hand still active")
	}
	if len(table.Hand.Board) != 3 {
		t.Fatalf("expected flop revealed (3 board cards), got %d", len(table.Hand.Board))
	}
	if table.Hand.ActionOn != 1 {
		t.Fatalf("expected actionOn=1 (BB first postflop in heads-up), got %d", table.Hand.ActionOn)
	}
	if table.Hand.ActionDeadline != 20 {
		t.Fatalf("expected actionDeadline=20 after timeout action at now=10, got %d", table.Hand.ActionDeadline)
	}
}
