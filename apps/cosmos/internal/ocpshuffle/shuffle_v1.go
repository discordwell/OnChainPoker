package ocpshuffle

import (
	"crypto/rand"
	"fmt"

	"onchainpoker/apps/cosmos/internal/ocpcrypto"
)

const (
	ShuffleProofV1Version = 1
	domainReencEqDlog     = "ocp/v1/shuffle/reenc-eqdlog"
)

func sampleNonzeroScalar(rng scalarRng) (ocpcrypto.Scalar, error) {
	for {
		s, err := rng.NextScalar()
		if err != nil {
			return ocpcrypto.Scalar{}, err
		}
		if !s.IsZero() {
			return s, nil
		}
	}
}

func reencryptAvoidingC1Collisions(rng scalarRng, pk ocpcrypto.Point, src ocpcrypto.ElGamalCiphertext, avoidC1s []ocpcrypto.Point) (ocpcrypto.ElGamalCiphertext, ocpcrypto.Scalar, error) {
	for {
		rho, err := sampleNonzeroScalar(rng)
		if err != nil {
			return ocpcrypto.ElGamalCiphertext{}, ocpcrypto.Scalar{}, err
		}
		ct := elgamalReencrypt(pk, src, rho)
		ok := true
		for _, a := range avoidC1s {
			if ocpcrypto.PointEq(ct.C1, a) {
				ok = false
				break
			}
		}
		if ok {
			return ct, rho, nil
		}
	}
}

func randomPermutation(rng scalarRng, n int) ([]int, error) {
	perm := make([]int, n)
	for i := 0; i < n; i++ {
		perm[i] = i
	}
	for i := n - 1; i > 0; i-- {
		b, err := rng.NextBytes(4)
		if err != nil {
			return nil, err
		}
		x := uint32(b[0]) | (uint32(b[1]) << 8) | (uint32(b[2]) << 16) | (uint32(b[3]) << 24)
		j := int(x % uint32(i+1))
		perm[i], perm[j] = perm[j], perm[i]
	}
	return perm, nil
}

func roundPairs(n int, round int) (pairs [][2]int, singles []int) {
	start := round % 2
	used := make([]bool, n)
	for i := start; i+1 < n; i += 2 {
		pairs = append(pairs, [2]int{i, i + 1})
		used[i] = true
		used[i+1] = true
	}
	for i := 0; i < n; i++ {
		if !used[i] {
			singles = append(singles, i)
		}
	}
	return pairs, singles
}

func ShuffleProveV1(pk ocpcrypto.Point, deckIn []ocpcrypto.ElGamalCiphertext, opts ShuffleProveOpts) (ShuffleProveResult, error) {
	n := len(deckIn)
	if n < 2 {
		return ShuffleProveResult{}, fmt.Errorf("shuffleProveV1: deck too small")
	}
	rounds := opts.Rounds
	if rounds == 0 {
		rounds = n
	}
	if rounds <= 0 {
		return ShuffleProveResult{}, fmt.Errorf("shuffleProveV1: rounds must be > 0")
	}

	seed := opts.Seed
	if len(seed) == 0 {
		seed = make([]byte, 32)
		if _, err := rand.Read(seed); err != nil {
			return ShuffleProveResult{}, err
		}
	}
	rng, err := NewDeterministicRng(seed)
	if err != nil {
		return ShuffleProveResult{}, err
	}

	perm, err := randomPermutation(rng, n)
	if err != nil {
		return ShuffleProveResult{}, err
	}
	type item struct {
		ct  ocpcrypto.ElGamalCiphertext
		key int
	}
	items := make([]item, n)
	for i := 0; i < n; i++ {
		items[i] = item{ct: deckIn[i], key: perm[i]}
	}

	header := make([]byte, 0, 5)
	header = append(header, byte(ShuffleProofV1Version))
	header = append(header, u16ToBytesLE(uint16(n))...)
	header = append(header, u16ToBytesLE(uint16(rounds))...)
	proofChunks := [][]byte{header}

	for round := 0; round < rounds; round++ {
		pairs, singles := roundPairs(n, round)
		next := make([]item, n)
		copy(next, items)

		deckOutRound := make([]ocpcrypto.ElGamalCiphertext, n)
		for i := 0; i < n; i++ {
			deckOutRound[i] = items[i].ct
		}

		switchProofs := [][]byte{}
		singleProofs := [][]byte{}

		// Process disjoint adjacent pairs (switch proofs).
		for _, ij := range pairs {
			i := ij[0]
			j := ij[1]

			left0 := items[i].ct
			left1 := items[j].ct

			swap := items[i].key > items[j].key
			src0 := left0
			src1 := left1
			if swap {
				src0 = left1
				src1 = left0
			}

			out0, rho0, err := reencryptAvoidingC1Collisions(rng, pk, src0, []ocpcrypto.Point{left0.C1, left1.C1})
			if err != nil {
				return ShuffleProveResult{}, err
			}
			out1, rho1, err := reencryptAvoidingC1Collisions(rng, pk, src1, []ocpcrypto.Point{left0.C1, left1.C1})
			if err != nil {
				return ShuffleProveResult{}, err
			}

			sp, err := proveSwitch(pk, left0, left1, out0, out1, swap, rho0, rho1, rng)
			if err != nil {
				return ShuffleProveResult{}, err
			}
			switchProofs = append(switchProofs, encodeSwitchProof(sp))

			deckOutRound[i] = out0
			deckOutRound[j] = out1

			next[i].ct = out0
			next[j].ct = out1
			if swap {
				next[i].key, next[j].key = next[j].key, next[i].key
			}
		}

		// Singles: plain eqdlog re-encryption proofs.
		for _, idx := range singles {
			inCt := items[idx].ct
			rho, err := sampleNonzeroScalar(rng)
			if err != nil {
				return ShuffleProveResult{}, err
			}
			outCt := elgamalReencrypt(pk, inCt, rho)

			X := ocpcrypto.PointSub(outCt.C1, inCt.C1)
			Y := ocpcrypto.PointSub(outCt.C2, inCt.C2)

			p, err := proveEqDlog(domainReencEqDlog, G, pk, X, Y, rho, rng)
			if err != nil {
				return ShuffleProveResult{}, err
			}
			singleProofs = append(singleProofs, encodeEqDlogProof(p))

			deckOutRound[idx] = outCt
			next[idx].ct = outCt
		}

		// Deck snapshot bytes (post-round).
		deckBytes := make([]byte, n*64)
		for i := 0; i < n; i++ {
			copy(deckBytes[i*64:], encodeCiphertext(deckOutRound[i]))
		}
		proofChunks = append(proofChunks, deckBytes)
		proofChunks = append(proofChunks, switchProofs...)
		proofChunks = append(proofChunks, singleProofs...)

		items = next
	}

	deckOut := make([]ocpcrypto.ElGamalCiphertext, n)
	for i := 0; i < n; i++ {
		deckOut[i] = items[i].ct
	}

	return ShuffleProveResult{DeckOut: deckOut, ProofBytes: concat(proofChunks...)}, nil
}

func concat(chunks ...[]byte) []byte {
	var n int
	for _, c := range chunks {
		n += len(c)
	}
	out := make([]byte, 0, n)
	for _, c := range chunks {
		out = append(out, c...)
	}
	return out
}

func ShuffleVerifyV1(pk ocpcrypto.Point, deckIn []ocpcrypto.ElGamalCiphertext, proofBytes []byte) ShuffleVerifyResult {
	rd := newReader(proofBytes)
	version, err := rd.takeU8()
	if err != nil {
		return ShuffleVerifyResult{OK: false, Error: err.Error()}
	}
	if version != ShuffleProofV1Version {
		return ShuffleVerifyResult{OK: false, Error: fmt.Sprintf("unsupported version %d", version)}
	}
	nU16, err := rd.takeU16LE()
	if err != nil {
		return ShuffleVerifyResult{OK: false, Error: err.Error()}
	}
	roundsU16, err := rd.takeU16LE()
	if err != nil {
		return ShuffleVerifyResult{OK: false, Error: err.Error()}
	}
	n := int(nU16)
	rounds := int(roundsU16)
	if n != len(deckIn) {
		return ShuffleVerifyResult{OK: false, Error: fmt.Sprintf("n mismatch: proof n=%d, deck n=%d", n, len(deckIn))}
	}
	if n < 2 {
		return ShuffleVerifyResult{OK: false, Error: "deck too small"}
	}
	if rounds <= 0 {
		return ShuffleVerifyResult{OK: false, Error: "rounds must be > 0"}
	}

	cur := make([]ocpcrypto.ElGamalCiphertext, n)
	copy(cur, deckIn)
	next := make([]ocpcrypto.ElGamalCiphertext, n)

	for round := 0; round < rounds; round++ {
		start := round % 2

		// 1) Deck snapshot
		deckBytes, err := rd.take(n * 64)
		if err != nil {
			return ShuffleVerifyResult{OK: false, Error: err.Error()}
		}
		for i := 0; i < n; i++ {
			ct, err := decodeCiphertext(deckBytes[i*64 : i*64+64])
			if err != nil {
				return ShuffleVerifyResult{OK: false, Error: err.Error()}
			}
			next[i] = ct
		}

		// 2) Switch proofs
		for i := start; i+1 < n; i += 2 {
			sp, err := decodeSwitchProofFromReader(rd)
			if err != nil {
				return ShuffleVerifyResult{OK: false, Error: err.Error()}
			}
			ok, err := verifySwitch(pk, cur[i], cur[i+1], next[i], next[i+1], sp)
			if err != nil {
				return ShuffleVerifyResult{OK: false, Error: err.Error()}
			}
			if !ok {
				return ShuffleVerifyResult{OK: false, Error: fmt.Sprintf("invalid switch proof at round=%d pair=(%d,%d)", round, i, i+1)}
			}
		}

		// 3) Single proofs
		if n%2 == 1 {
			var idx int
			if start == 0 {
				idx = n - 1
			} else {
				idx = 0
			}
			p, err := decodeEqDlogProofFromReader(rd)
			if err != nil {
				return ShuffleVerifyResult{OK: false, Error: err.Error()}
			}
			if ocpcrypto.PointEq(next[idx].C1, cur[idx].C1) {
				return ShuffleVerifyResult{OK: false, Error: fmt.Sprintf("single not rerandomized at round=%d idx=%d", round, idx)}
			}
			X := ocpcrypto.PointSub(next[idx].C1, cur[idx].C1)
			Y := ocpcrypto.PointSub(next[idx].C2, cur[idx].C2)
			ok, err := verifyEqDlog(domainReencEqDlog, G, pk, X, Y, p)
			if err != nil {
				return ShuffleVerifyResult{OK: false, Error: err.Error()}
			}
			if !ok {
				return ShuffleVerifyResult{OK: false, Error: fmt.Sprintf("invalid single proof at round=%d idx=%d", round, idx)}
			}
		} else if start == 1 {
			const idxFirst = 0
			p, err := decodeEqDlogProofFromReader(rd)
			if err != nil {
				return ShuffleVerifyResult{OK: false, Error: err.Error()}
			}
			if ocpcrypto.PointEq(next[idxFirst].C1, cur[idxFirst].C1) {
				return ShuffleVerifyResult{OK: false, Error: fmt.Sprintf("single not rerandomized at round=%d idx=%d", round, idxFirst)}
			}
			X := ocpcrypto.PointSub(next[idxFirst].C1, cur[idxFirst].C1)
			Y := ocpcrypto.PointSub(next[idxFirst].C2, cur[idxFirst].C2)
			ok, err := verifyEqDlog(domainReencEqDlog, G, pk, X, Y, p)
			if err != nil {
				return ShuffleVerifyResult{OK: false, Error: err.Error()}
			}
			if !ok {
				return ShuffleVerifyResult{OK: false, Error: fmt.Sprintf("invalid single proof at round=%d idx=%d", round, idxFirst)}
			}

			idxLast := n - 1
			p, err = decodeEqDlogProofFromReader(rd)
			if err != nil {
				return ShuffleVerifyResult{OK: false, Error: err.Error()}
			}
			if ocpcrypto.PointEq(next[idxLast].C1, cur[idxLast].C1) {
				return ShuffleVerifyResult{OK: false, Error: fmt.Sprintf("single not rerandomized at round=%d idx=%d", round, idxLast)}
			}
			X = ocpcrypto.PointSub(next[idxLast].C1, cur[idxLast].C1)
			Y = ocpcrypto.PointSub(next[idxLast].C2, cur[idxLast].C2)
			ok, err = verifyEqDlog(domainReencEqDlog, G, pk, X, Y, p)
			if err != nil {
				return ShuffleVerifyResult{OK: false, Error: err.Error()}
			}
			if !ok {
				return ShuffleVerifyResult{OK: false, Error: fmt.Sprintf("invalid single proof at round=%d idx=%d", round, idxLast)}
			}
		}

		cur, next = next, cur
	}

	if !rd.done() {
		return ShuffleVerifyResult{OK: false, Error: "trailing bytes in proof"}
	}
	return ShuffleVerifyResult{OK: true, DeckOut: cur}
}
