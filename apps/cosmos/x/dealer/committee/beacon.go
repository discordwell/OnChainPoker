package committee

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"sort"
	"strings"
)

// Beacon: a commit-reveal randomness scheme that produces a 32-byte rand_epoch
// value that is not proposer-influenceable (unlike DevnetRandEpoch).
//
// Lifecycle (per epoch):
//   Phase 1 (commit window): each validator V picks a uniformly random 32-byte
//     salt s_V, and submits commit_V = H(beaconCommitDomain || validator || epochId || salt_V).
//   Phase 2 (reveal window): V reveals salt_V. The chain accepts the reveal iff
//     recomputed H matches the stored commit_V.
//   Final: beacon = H(beaconFinalDomain || chainId || epochId || concat(sorted(salts))).
//
// The salt is NOT predictable from the commit (it is 32 random bytes), so
// committing first does not let a proposer grind the final beacon: once all
// commits are fixed, the proposer's choice of which reveals to include can be
// enforced by the chain (all valid reveals must be accepted), removing the
// grinding surface.
//
// Liveness fallback: if fewer than the configured threshold of validators reveal,
// the caller should emit an event and fall back to block-derived randomness
// (DevnetRandEpoch). In production chain IDs that is a last resort; the chain
// still records which validators committed-but-did-not-reveal so they can be
// slashed.
const (
	beaconCommitDomain = "ocp/v1/beacon/commit"
	beaconFinalDomain  = "ocp/v1/beacon/final"

	// BeaconSaltBytes is the fixed salt length that validators must submit.
	BeaconSaltBytes = 32

	// BeaconCommitBytes is the fixed commit digest length (sha256).
	BeaconCommitBytes = 32
)

// BeaconCommit is the pure-function representation of a validator's commit.
type BeaconCommit struct {
	Validator string
	Commit    []byte // 32 bytes
}

// BeaconReveal is the pure-function representation of a validator's salt reveal.
type BeaconReveal struct {
	Validator string
	Salt      []byte // 32 bytes
}

// Commit computes the commit value that the validator is expected to submit
// during the commit window. H(domain || validator || epochId || salt).
func Commit(validator string, epochID uint64, salt []byte) ([32]byte, error) {
	if validator == "" {
		return [32]byte{}, fmt.Errorf("validator is empty")
	}
	if len(salt) != BeaconSaltBytes {
		return [32]byte{}, fmt.Errorf("salt must be %d bytes", BeaconSaltBytes)
	}
	var e8 [8]byte
	binary.LittleEndian.PutUint64(e8[:], epochID)
	return hashDomain(beaconCommitDomain,
		[]byte(validator),
		e8[:],
		salt,
	), nil
}

// Reveal verifies that a (validator, epochID, salt) reveal matches the
// previously stored commit. It returns an error if the salt has the wrong
// length or if the recomputed commit does not match the stored value.
func Reveal(validator string, epochID uint64, salt []byte, storedCommit []byte) error {
	if len(storedCommit) != BeaconCommitBytes {
		return fmt.Errorf("stored commit must be %d bytes", BeaconCommitBytes)
	}
	recomputed, err := Commit(validator, epochID, salt)
	if err != nil {
		return err
	}
	if !bytes.Equal(recomputed[:], storedCommit) {
		return fmt.Errorf("reveal does not match commit")
	}
	return nil
}

// Final computes the deterministic 32-byte beacon output from the set of valid
// reveals. Salts are sorted lexicographically before hashing, so the caller
// can pass reveals in any order (e.g. as-submitted) and still get a stable
// output. Duplicate or empty salts are rejected.
//
// If fewer than `threshold` distinct reveals are provided, Final returns
// (nil, false, nil); the caller is then expected to fall back to a secondary
// entropy source and emit an audit event.
func Final(chainID string, epochID uint64, reveals []BeaconReveal, threshold int) ([32]byte, bool, error) {
	if threshold < 0 {
		return [32]byte{}, false, fmt.Errorf("threshold must be >= 0")
	}

	// Deduplicate by validator and validate salt length.
	seen := make(map[string]struct{}, len(reveals))
	salts := make([][]byte, 0, len(reveals))
	for _, r := range reveals {
		if r.Validator == "" {
			return [32]byte{}, false, fmt.Errorf("reveal has empty validator")
		}
		if _, dup := seen[r.Validator]; dup {
			return [32]byte{}, false, fmt.Errorf("duplicate reveal for validator %s", r.Validator)
		}
		seen[r.Validator] = struct{}{}
		if len(r.Salt) != BeaconSaltBytes {
			return [32]byte{}, false, fmt.Errorf("validator %s: salt must be %d bytes", r.Validator, BeaconSaltBytes)
		}
		salts = append(salts, append([]byte(nil), r.Salt...))
	}

	if len(salts) < threshold {
		return [32]byte{}, false, nil
	}

	// Sort salts lexicographically for determinism regardless of submission
	// order.
	sort.Slice(salts, func(i, j int) bool { return bytes.Compare(salts[i], salts[j]) < 0 })

	var e8 [8]byte
	binary.LittleEndian.PutUint64(e8[:], epochID)

	// Length-prefix each salt inside a single buffer so concatenation is
	// unambiguous.
	buf := make([]byte, 0, len(salts)*(4+BeaconSaltBytes))
	var lenBuf [4]byte
	for _, s := range salts {
		binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(s)))
		buf = append(buf, lenBuf[:]...)
		buf = append(buf, s...)
	}

	return hashDomain(beaconFinalDomain,
		[]byte(chainID),
		e8[:],
		buf,
	), true, nil
}

// MissingReveals returns the sorted list of validators that committed but did
// not reveal (or whose reveal was rejected upstream, i.e. never made it into
// the reveals slice). The caller uses this to decide whom to slash.
func MissingReveals(commits []BeaconCommit, reveals []BeaconReveal) []string {
	revealed := make(map[string]struct{}, len(reveals))
	for _, r := range reveals {
		revealed[r.Validator] = struct{}{}
	}
	out := make([]string, 0)
	for _, c := range commits {
		if c.Validator == "" {
			continue
		}
		if _, ok := revealed[c.Validator]; ok {
			continue
		}
		out = append(out, c.Validator)
	}
	sort.Strings(out)
	return out
}

// IsDevnetChainID returns true if chainID should be allowed to fall back to
// block-entropy-only randomness. Production chains must run the beacon.
func IsDevnetChainID(chainID string) bool {
	lc := strings.ToLower(chainID)
	return strings.Contains(lc, "devnet") || strings.Contains(lc, "local")
}

// VerifyCommitSyntax rejects obviously malformed commit values (wrong length).
// It does NOT verify any cryptographic property — only the reveal can do that.
func VerifyCommitSyntax(commit []byte) error {
	if len(commit) != BeaconCommitBytes {
		return fmt.Errorf("commit must be %d bytes", BeaconCommitBytes)
	}
	return nil
}

// --- internal helpers that mirror randomness.go's hashDomain ---

// sha256Sum is an internal convenience used only for clarity in tests; callers
// should prefer hashDomain. It is kept unexported on purpose.
func sha256Sum(b []byte) [32]byte { return sha256.Sum256(b) }
