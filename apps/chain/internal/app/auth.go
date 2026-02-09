package app

import (
	"crypto/ed25519"
	"crypto/sha256"
	"fmt"

	"onchainpoker/apps/chain/internal/codec"
	"onchainpoker/apps/chain/internal/state"
)

const txAuthDomainV0 = "ocp/tx/v0"

func txAuthSignBytesV0(typ string, value []byte, nonce string, signer string) []byte {
	// signBytes = DOMAIN || 0x00 || type || 0x00 || nonce || 0x00 || signer || 0x00 || sha256(value)
	sum := sha256.Sum256(value)
	out := make([]byte, 0, len(txAuthDomainV0)+1+len(typ)+1+len(nonce)+1+len(signer)+1+sha256.Size)
	out = append(out, []byte(txAuthDomainV0)...)
	out = append(out, 0)
	out = append(out, []byte(typ)...)
	out = append(out, 0)
	out = append(out, []byte(nonce)...)
	out = append(out, 0)
	out = append(out, []byte(signer)...)
	out = append(out, 0)
	out = append(out, sum[:]...)
	return out
}

func requireSignedEnvelope(env codec.TxEnvelope) error {
	if env.Nonce == "" {
		return fmt.Errorf("missing tx.nonce")
	}
	if env.Signer == "" {
		return fmt.Errorf("missing tx.signer")
	}
	if len(env.Sig) == 0 {
		return fmt.Errorf("missing tx.sig")
	}
	if len(env.Sig) != ed25519.SignatureSize {
		return fmt.Errorf("invalid tx.sig length: got %d want %d", len(env.Sig), ed25519.SignatureSize)
	}
	return nil
}

func requireValidatorAuth(st *state.State, env codec.TxEnvelope, validatorID string) error {
	if st == nil {
		return fmt.Errorf("state is nil")
	}
	if validatorID == "" {
		return fmt.Errorf("missing validatorId")
	}
	if err := requireSignedEnvelope(env); err != nil {
		return err
	}
	if env.Signer != validatorID {
		return fmt.Errorf("tx signer mismatch: signer=%q want=%q", env.Signer, validatorID)
	}
	v := findValidator(st, validatorID)
	if v == nil {
		return fmt.Errorf("validator not registered")
	}
	if len(v.PubKey) != ed25519.PublicKeySize {
		return fmt.Errorf("validator %q missing pubKey", validatorID)
	}
	msg := txAuthSignBytesV0(env.Type, env.Value, env.Nonce, env.Signer)
	if !ed25519.Verify(ed25519.PublicKey(v.PubKey), msg, env.Sig) {
		return fmt.Errorf("invalid signature")
	}
	return nil
}

func requireRegisterValidatorAuth(env codec.TxEnvelope, msg codec.StakingRegisterValidatorTx) error {
	if msg.ValidatorID == "" {
		return fmt.Errorf("missing validatorId")
	}
	if len(msg.PubKey) != ed25519.PublicKeySize {
		return fmt.Errorf("pubKey must be %d bytes", ed25519.PublicKeySize)
	}
	if err := requireSignedEnvelope(env); err != nil {
		return err
	}
	if env.Signer != msg.ValidatorID {
		return fmt.Errorf("tx signer mismatch: signer=%q want=%q", env.Signer, msg.ValidatorID)
	}
	pub := ed25519.PublicKey(msg.PubKey)
	msgBytes := txAuthSignBytesV0(env.Type, env.Value, env.Nonce, env.Signer)
	if !ed25519.Verify(pub, msgBytes, env.Sig) {
		return fmt.Errorf("invalid signature")
	}
	return nil
}

func requireRegisterAccountAuth(env codec.TxEnvelope, msg codec.AuthRegisterAccountTx) error {
	if msg.Account == "" {
		return fmt.Errorf("missing account")
	}
	if len(msg.PubKey) != ed25519.PublicKeySize {
		return fmt.Errorf("pubKey must be %d bytes", ed25519.PublicKeySize)
	}
	if err := requireSignedEnvelope(env); err != nil {
		return err
	}
	if env.Signer != msg.Account {
		return fmt.Errorf("tx signer mismatch: signer=%q want=%q", env.Signer, msg.Account)
	}
	pub := ed25519.PublicKey(msg.PubKey)
	msgBytes := txAuthSignBytesV0(env.Type, env.Value, env.Nonce, env.Signer)
	if !ed25519.Verify(pub, msgBytes, env.Sig) {
		return fmt.Errorf("invalid signature")
	}
	return nil
}

func requireAccountAuth(st *state.State, env codec.TxEnvelope, account string) error {
	if st == nil {
		return fmt.Errorf("state is nil")
	}
	if account == "" {
		return fmt.Errorf("missing account")
	}
	if err := requireSignedEnvelope(env); err != nil {
		return err
	}
	if env.Signer != account {
		return fmt.Errorf("tx signer mismatch: signer=%q want=%q", env.Signer, account)
	}
	pub := st.AccountKeys[account]
	if len(pub) != ed25519.PublicKeySize {
		return fmt.Errorf("account %q missing pubKey (auth/register_account required)", account)
	}
	msg := txAuthSignBytesV0(env.Type, env.Value, env.Nonce, env.Signer)
	if !ed25519.Verify(ed25519.PublicKey(pub), msg, env.Sig) {
		return fmt.Errorf("invalid signature")
	}
	return nil
}
