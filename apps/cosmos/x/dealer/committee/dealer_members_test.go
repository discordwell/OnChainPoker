package committee

import "testing"

func TestDealerMembersFromSnapshots_SortsAndAssignsIndices(t *testing.T) {
	snaps := []MemberSnapshot{
		{Operator: "valoper1bbb", ConsPubKey: bytesRepeatForTest(0xbb, 32)},
		{Operator: "valoper1aaa", ConsPubKey: bytesRepeatForTest(0xaa, 32)},
	}

	members, err := DealerMembersFromSnapshots(snaps)
	if err != nil {
		t.Fatalf("DealerMembersFromSnapshots: %v", err)
	}
	if len(members) != 2 {
		t.Fatalf("expected 2 members, got %d", len(members))
	}
	if members[0].Validator != "valoper1aaa" || members[0].Index != 1 {
		t.Fatalf("unexpected first member: %#v", members[0])
	}
	if members[1].Validator != "valoper1bbb" || members[1].Index != 2 {
		t.Fatalf("unexpected second member: %#v", members[1])
	}
	if len(members[0].ConsPubkey) != 32 || members[0].ConsPubkey[0] != 0xaa {
		t.Fatalf("unexpected first member pubkey")
	}
	if len(members[1].ConsPubkey) != 32 || members[1].ConsPubkey[0] != 0xbb {
		t.Fatalf("unexpected second member pubkey")
	}
}

func TestDealerMembersFromSnapshots_RejectsDuplicates(t *testing.T) {
	_, err := DealerMembersFromSnapshots([]MemberSnapshot{
		{Operator: "valoper1dup", ConsPubKey: bytesRepeatForTest(0xaa, 32)},
		{Operator: "valoper1dup", ConsPubKey: bytesRepeatForTest(0xbb, 32)},
	})
	if err == nil {
		t.Fatalf("expected error for duplicate operators")
	}
}

func bytesRepeatForTest(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}
