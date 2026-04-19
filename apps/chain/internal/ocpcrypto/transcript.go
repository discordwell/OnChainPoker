package ocpcrypto

import (
	"crypto/sha512"
	"fmt"
)

var (
	transcriptPrefix = []byte("OCPv1|transcript|")
)

// Transcript is a Fiat-Shamir transcript following docs/INTERFACES.md 4.3.
//
// It intentionally stores the transcript bytes rather than a mutable hash state,
// since Go's sha512 hash implementation does not support cloning.
type Transcript struct {
	state []byte
}

func NewTranscript(domainSep string) *Transcript {
	dst := []byte(domainSep)
	st := make([]byte, 0, len(transcriptPrefix)+4+len(dst))
	st = append(st, transcriptPrefix...)
	st = append(st, u32le(uint32(len(dst)))...)
	st = append(st, dst...)
	return &Transcript{state: st}
}

func (t *Transcript) AppendMessage(label string, msg []byte) error {
	if t == nil {
		return fmt.Errorf("transcript: nil receiver")
	}
	if msg == nil {
		return fmt.Errorf("transcript: nil msg")
	}
	lb := []byte(label)
	t.state = append(t.state, []byte("msg")...)
	t.state = append(t.state, u32le(uint32(len(lb)))...)
	t.state = append(t.state, lb...)
	t.state = append(t.state, u32le(uint32(len(msg)))...)
	t.state = append(t.state, msg...)
	return nil
}

func (t *Transcript) ChallengeScalar(label string) (Scalar, error) {
	if t == nil {
		return Scalar{}, fmt.Errorf("transcript: nil receiver")
	}
	lb := []byte(label)
	h := sha512.New()
	h.Write(t.state)
	h.Write([]byte("challenge"))
	h.Write(u32le(uint32(len(lb))))
	h.Write(lb)
	digest := h.Sum(nil) // 64 bytes
	// Fold the raw 64-byte challenge digest (pre-reduction) back into the
	// persistent transcript state, tagged with "chal" and the challenge
	// label, mirroring the framing used by AppendMessage. This binds later
	// challenges to earlier ones for multi-round protocols. For any
	// single-challenge caller the value of `digest` above (and thus the
	// returned scalar) is unchanged from the unfolded implementation, so
	// the change is backward-compatible for every existing proof.
	t.state = append(t.state, []byte("chal")...)
	t.state = append(t.state, u32le(uint32(len(lb)))...)
	t.state = append(t.state, lb...)
	t.state = append(t.state, u32le(uint32(len(digest)))...)
	t.state = append(t.state, digest...)
	return ScalarFromUniformBytes(digest)
}

