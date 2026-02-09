package app

import (
	"encoding/binary"
	"fmt"
)

const (
	dkgShareMsgMagicV1  = "OCP1"
	dkgShareMsgDomainV1 = "ocp/dkg/sharemsg/v1"
)

type dkgShareMsgV1 struct {
	EpochID  uint64
	DealerID string
	ToID     string
	Share    []byte // 32 bytes scalar
	Sig      []byte // 64 bytes ed25519 signature

	// Body is the signed payload prefix (everything up to, but excluding, Sig).
	Body []byte
}

func decodeDKGShareMsgV1(b []byte) (*dkgShareMsgV1, error) {
	// Encoding:
	//   magic(4) || epochId(u64le) || dealerLen(u16le) || dealerId || toLen(u16le) || toId || share(32) || sig(64)
	min := 4 + 8 + 2 + 2 + 32 + 64
	if len(b) < min {
		return nil, fmt.Errorf("shareMsg too short")
	}
	if string(b[:4]) != dkgShareMsgMagicV1 {
		return nil, fmt.Errorf("shareMsg bad magic")
	}
	off := 4
	epochID := binary.LittleEndian.Uint64(b[off : off+8])
	off += 8

	dealerLen := int(binary.LittleEndian.Uint16(b[off : off+2]))
	off += 2
	if dealerLen <= 0 || off+dealerLen+2 > len(b) {
		return nil, fmt.Errorf("shareMsg bad dealerId length")
	}
	dealerID := string(b[off : off+dealerLen])
	off += dealerLen

	toLen := int(binary.LittleEndian.Uint16(b[off : off+2]))
	off += 2
	if toLen <= 0 || off+toLen+32+64 > len(b) {
		return nil, fmt.Errorf("shareMsg bad toId length")
	}
	toID := string(b[off : off+toLen])
	off += toLen

	share := append([]byte(nil), b[off:off+32]...)
	off += 32
	sig := append([]byte(nil), b[off:off+64]...)
	off += 64

	if off != len(b) {
		return nil, fmt.Errorf("shareMsg trailing bytes")
	}

	return &dkgShareMsgV1{
		EpochID:  epochID,
		DealerID: dealerID,
		ToID:     toID,
		Share:    share,
		Sig:      sig,
		Body:     append([]byte(nil), b[:len(b)-64]...),
	}, nil
}

