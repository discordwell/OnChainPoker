package committee

import (
	"fmt"
	"sort"

	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

// DealerMembersFromSnapshots converts snapshots into canonical DealerMember entries.
// Members are sorted by operator address and assigned 1..N indices.
func DealerMembersFromSnapshots(snaps []MemberSnapshot) ([]dealertypes.DealerMember, error) {
	if len(snaps) == 0 {
		return []dealertypes.DealerMember{}, nil
	}

	ordered := append([]MemberSnapshot(nil), snaps...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].Operator < ordered[j].Operator })

	out := make([]dealertypes.DealerMember, 0, len(ordered))
	seenOps := make(map[string]struct{}, len(ordered))
	for i, s := range ordered {
		if s.Operator == "" {
			return nil, fmt.Errorf("member operator address is empty")
		}
		if _, exists := seenOps[s.Operator]; exists {
			return nil, fmt.Errorf("duplicate member operator: %s", s.Operator)
		}
		seenOps[s.Operator] = struct{}{}

		if len(s.ConsPubKey) != 32 {
			return nil, fmt.Errorf("member %s consensus pubkey is %d bytes, expected 32", s.Operator, len(s.ConsPubKey))
		}

		out = append(out, dealertypes.DealerMember{
			Validator:  s.Operator,
			Index:      uint32(i + 1),
			PubShare:   nil,
			ConsPubkey: append([]byte(nil), s.ConsPubKey...),
			Power:      s.Power,
		})
	}

	return out, nil
}
