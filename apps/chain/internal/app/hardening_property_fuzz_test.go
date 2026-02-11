package app

import (
	"math/big"
	"math/rand"
	"testing"
)

func bigU64(v uint64) *big.Int {
	return new(big.Int).SetUint64(v)
}

func FuzzComputeSidePots_Conservation(f *testing.F) {
	f.Add(uint64(10), uint64(10), uint64(10), uint64(0), uint64(0), uint64(0), uint64(0), uint64(0), uint64(0), uint16(0x7))
	f.Add(^uint64(0), uint64(1), uint64(0), uint64(0), uint64(0), uint64(0), uint64(0), uint64(0), uint64(0), uint16(0x3))

	f.Fuzz(func(t *testing.T, c0, c1, c2, c3, c4, c5, c6, c7, c8 uint64, eligibleMask uint16) {
		totalCommit := [9]uint64{c0, c1, c2, c3, c4, c5, c6, c7, c8}
		var eligible [9]bool
		for i := 0; i < 9; i++ {
			eligible[i] = (eligibleMask & (1 << i)) != 0
		}

		pots, err := computeSidePots(totalCommit, eligible)
		if err != nil {
			// Overflow-guard failures are expected for adversarial large inputs.
			return
		}

		sumCommit := new(big.Int)
		for i := 0; i < 9; i++ {
			sumCommit.Add(sumCommit, bigU64(totalCommit[i]))
		}

		sumPots := new(big.Int)
		for _, p := range pots {
			sumPots.Add(sumPots, bigU64(p.Amount))
			for _, seat := range p.EligibleSeats {
				if seat < 0 || seat > 8 {
					t.Fatalf("invalid eligible seat index: %d", seat)
				}
				if !eligible[seat] {
					t.Fatalf("ineligible seat %d included in pot", seat)
				}
			}
		}

		if sumPots.Cmp(sumCommit) != 0 {
			t.Fatalf("chip conservation failed: commits=%s pots=%s", sumCommit.String(), sumPots.String())
		}
	})
}

func TestProperty_ChipConservation_LargeStacks(t *testing.T) {
	const (
		height = int64(1)
		loops  = 25
	)

	r := rand.New(rand.NewSource(1337))
	base := ^uint64(0) / 8
	span := uint64(1_000_000)

	for i := 0; i < loops; i++ {
		a := newTestApp(t)

		stackA := base + (r.Uint64() % span)
		stackB := base + (r.Uint64() % span)

		mintTestTokens(t, a, height, "alice", stackA)
		mintTestTokens(t, a, height, "bob", stackB)
		registerTestAccount(t, a, height, "alice")
		registerTestAccount(t, a, height, "bob")

		createRes := mustOk(t, a.deliverTx(txBytesSigned(t, "poker/create_table", map[string]any{
			"creator":    "alice",
			"smallBlind": 1,
			"bigBlind":   2,
			"minBuyIn":   1,
			"maxBuyIn":   ^uint64(0),
		}, "alice"), height, 0))
		tableID := parseU64(t, attr(findEvent(createRes.Events, "TableCreated"), "tableId"))

		mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{
			"player":  "alice",
			"tableId": tableID,
			"seat":    0,
			"buyIn":   stackA,
		}, "alice"), height, 0))
		mustOk(t, a.deliverTx(txBytesSigned(t, "poker/sit", map[string]any{
			"player":  "bob",
			"tableId": tableID,
			"seat":    1,
			"buyIn":   stackB,
		}, "bob"), height, 0))
		mustOk(t, a.deliverTx(txBytesSigned(t, "poker/start_hand", map[string]any{
			"caller":  "alice",
			"tableId": tableID,
		}, "alice"), height, 0))

		for step := 0; step < 256; step++ {
			table := a.st.Tables[tableID]
			if table == nil || table.Hand == nil {
				break
			}
			actor := table.Hand.ActionOn
			if actor < 0 || actor >= 9 || table.Seats[actor] == nil {
				t.Fatalf("invalid actionOn during loop=%d step=%d: %d", i, step, actor)
			}
			player := table.Seats[actor].Player
			action := "check"
			if toCall(table.Hand, actor) != 0 {
				action = "call"
			}
			mustOk(t, a.deliverTx(txBytesSigned(t, "poker/act", map[string]any{
				"player":  player,
				"tableId": tableID,
				"action":  action,
			}, player), height, 0))
		}

		table := a.st.Tables[tableID]
		if table == nil {
			t.Fatalf("table unexpectedly missing")
		}
		if table.Hand != nil {
			t.Fatalf("hand did not complete within step bound")
		}

		got := new(big.Int)
		for seat := 0; seat < 9; seat++ {
			if table.Seats[seat] == nil {
				continue
			}
			got.Add(got, bigU64(table.Seats[seat].Stack))
		}
		want := new(big.Int).Add(bigU64(stackA), bigU64(stackB))
		if got.Cmp(want) != 0 {
			t.Fatalf("chip conservation failed loop=%d: want=%s got=%s", i, want.String(), got.String())
		}
	}
}
