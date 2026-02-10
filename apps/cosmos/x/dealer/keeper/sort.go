package keeper

import (
	"sort"

	dealertypes "onchainpoker/apps/cosmos/x/dealer/types"
)

func sortDKGCommits(dkg *dealertypes.DealerDKG) {
	if dkg == nil {
		return
	}
	sort.Slice(dkg.Commits, func(i, j int) bool { return dkg.Commits[i].Dealer < dkg.Commits[j].Dealer })
}

func sortDKGComplaints(dkg *dealertypes.DealerDKG) {
	if dkg == nil {
		return
	}
	sort.Slice(dkg.Complaints, func(i, j int) bool {
		if dkg.Complaints[i].Dealer != dkg.Complaints[j].Dealer {
			return dkg.Complaints[i].Dealer < dkg.Complaints[j].Dealer
		}
		return dkg.Complaints[i].Complainer < dkg.Complaints[j].Complainer
	})
}

func sortDKGReveals(dkg *dealertypes.DealerDKG) {
	if dkg == nil {
		return
	}
	sort.Slice(dkg.Reveals, func(i, j int) bool {
		if dkg.Reveals[i].Dealer != dkg.Reveals[j].Dealer {
			return dkg.Reveals[i].Dealer < dkg.Reveals[j].Dealer
		}
		return dkg.Reveals[i].To < dkg.Reveals[j].To
	})
}

func sortPubShares(h *dealertypes.DealerHand) {
	if h == nil {
		return
	}
	sort.Slice(h.PubShares, func(i, j int) bool {
		if h.PubShares[i].Pos != h.PubShares[j].Pos {
			return h.PubShares[i].Pos < h.PubShares[j].Pos
		}
		return h.PubShares[i].Validator < h.PubShares[j].Validator
	})
}

func sortEncShares(h *dealertypes.DealerHand) {
	if h == nil {
		return
	}
	sort.Slice(h.EncShares, func(i, j int) bool {
		if h.EncShares[i].Pos != h.EncShares[j].Pos {
			return h.EncShares[i].Pos < h.EncShares[j].Pos
		}
		return h.EncShares[i].Validator < h.EncShares[j].Validator
	})
}
