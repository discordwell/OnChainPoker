package ocpcrypto

import (
	"encoding/hex"
	"fmt"
	"strings"
)

func hexToBytes(s string) ([]byte, error) {
	if s == "" {
		return nil, fmt.Errorf("hex: empty string")
	}
	ss := strings.TrimPrefix(strings.ToLower(s), "0x")
	if len(ss)%2 != 0 {
		return nil, fmt.Errorf("hex: odd length")
	}
	b, err := hex.DecodeString(ss)
	if err != nil {
		return nil, fmt.Errorf("hex: %w", err)
	}
	return b, nil
}

func bytesToHex(b []byte) string {
	return "0x" + strings.ToLower(hex.EncodeToString(b))
}

