package keeper

import (
	"context"
	"testing"
	"time"

	sdkmath "cosmossdk.io/math"
	cmtprotocrypto "github.com/cometbft/cometbft/proto/tendermint/crypto"

	cryptotypes "github.com/cosmos/cosmos-sdk/crypto/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	slashingtypes "github.com/cosmos/cosmos-sdk/x/slashing/types"
	stakingtypes "github.com/cosmos/cosmos-sdk/x/staking/types"
	"github.com/stretchr/testify/require"
)

type fakeValidator struct {
	jailed   bool
	consAddr sdk.ConsAddress
}

func (v fakeValidator) IsJailed() bool                          { return v.jailed }
func (v fakeValidator) GetMoniker() string                      { return "" }
func (v fakeValidator) GetStatus() stakingtypes.BondStatus      { return stakingtypes.Unbonded }
func (v fakeValidator) IsBonded() bool                          { return false }
func (v fakeValidator) IsUnbonded() bool                        { return true }
func (v fakeValidator) IsUnbonding() bool                       { return false }
func (v fakeValidator) GetOperator() string                     { return "" }
func (v fakeValidator) ConsPubKey() (cryptotypes.PubKey, error) { return nil, nil }
func (v fakeValidator) TmConsPublicKey() (cmtprotocrypto.PublicKey, error) {
	return cmtprotocrypto.PublicKey{}, nil
}
func (v fakeValidator) GetConsAddr() ([]byte, error)          { return []byte(v.consAddr), nil }
func (v fakeValidator) GetTokens() sdkmath.Int                { return sdkmath.ZeroInt() }
func (v fakeValidator) GetBondedTokens() sdkmath.Int          { return sdkmath.ZeroInt() }
func (v fakeValidator) GetConsensusPower(_ sdkmath.Int) int64 { return 0 }
func (v fakeValidator) GetCommission() sdkmath.LegacyDec      { return sdkmath.LegacyZeroDec() }
func (v fakeValidator) GetMinSelfDelegation() sdkmath.Int     { return sdkmath.ZeroInt() }
func (v fakeValidator) GetDelegatorShares() sdkmath.LegacyDec { return sdkmath.LegacyZeroDec() }
func (v fakeValidator) TokensFromShares(_ sdkmath.LegacyDec) sdkmath.LegacyDec {
	return sdkmath.LegacyZeroDec()
}
func (v fakeValidator) TokensFromSharesTruncated(_ sdkmath.LegacyDec) sdkmath.LegacyDec {
	return sdkmath.LegacyZeroDec()
}
func (v fakeValidator) TokensFromSharesRoundUp(_ sdkmath.LegacyDec) sdkmath.LegacyDec {
	return sdkmath.LegacyZeroDec()
}
func (v fakeValidator) SharesFromTokens(_ sdkmath.Int) (sdkmath.LegacyDec, error) {
	return sdkmath.LegacyZeroDec(), nil
}
func (v fakeValidator) SharesFromTokensTruncated(_ sdkmath.Int) (sdkmath.LegacyDec, error) {
	return sdkmath.LegacyZeroDec(), nil
}
func (v fakeValidator) GetValidatorPower() sdkmath.Int { return sdkmath.ZeroInt() }

type fakeStakingKeeper struct {
	val    stakingtypes.ValidatorI
	bonded []stakingtypes.Validator
}

func (k fakeStakingKeeper) Validator(_ context.Context, _ sdk.ValAddress) (stakingtypes.ValidatorI, error) {
	return k.val, nil
}

func (k fakeStakingKeeper) GetBondedValidatorsByPower(_ context.Context) ([]stakingtypes.Validator, error) {
	return k.bonded, nil
}

type fakeSlashingKeeper struct {
	slashCalls int
	jailCalls  int

	lastSlashConsAddr           sdk.ConsAddress
	lastSlashFraction           sdkmath.LegacyDec
	lastSlashPower              int64
	lastSlashDistributionHeight int64
	lastSlashInfraction         stakingtypes.Infraction

	lastJailConsAddr sdk.ConsAddress

	signingInfo slashingtypes.ValidatorSigningInfo
	jailUntil   *time.Time
}

func (k *fakeSlashingKeeper) SlashWithInfractionReason(
	_ context.Context,
	consAddr sdk.ConsAddress,
	fraction sdkmath.LegacyDec,
	power int64,
	distributionHeight int64,
	infraction stakingtypes.Infraction,
) error {
	k.slashCalls++
	k.lastSlashConsAddr = consAddr
	k.lastSlashFraction = fraction
	k.lastSlashPower = power
	k.lastSlashDistributionHeight = distributionHeight
	k.lastSlashInfraction = infraction
	return nil
}

func (k *fakeSlashingKeeper) Jail(_ context.Context, consAddr sdk.ConsAddress) error {
	k.jailCalls++
	k.lastJailConsAddr = consAddr
	return nil
}

func (k *fakeSlashingKeeper) GetValidatorSigningInfo(_ context.Context, _ sdk.ConsAddress) (slashingtypes.ValidatorSigningInfo, error) {
	return k.signingInfo, nil
}

func (k *fakeSlashingKeeper) JailUntil(_ context.Context, _ sdk.ConsAddress, jailTime time.Time) error {
	k.jailUntil = &jailTime
	return nil
}

func TestSlashAndJailValidator_SlashesJailsAndExtendsJailUntil(t *testing.T) {
	consAddr := sdk.ConsAddress([]byte("consaddr"))
	val := fakeValidator{jailed: false, consAddr: consAddr}

	stakingKeeper := fakeStakingKeeper{val: val, bonded: []stakingtypes.Validator{{}, {}}}
	slashingKeeper := &fakeSlashingKeeper{
		signingInfo: slashingtypes.ValidatorSigningInfo{JailedUntil: time.Unix(0, 0).UTC()},
	}

	// Need an SDK context for BlockTime().
	sdkCtx := sdk.Context{}.WithBlockTime(time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	err := SlashAndJailValidator(
		ctx,
		stakingKeeper,
		slashingKeeper,
		sdk.ValAddress([]byte("valoper")),
		10,
		123,
		sdkmath.LegacyMustNewDecFromStr("0.01"),
		2*time.Hour,
	)
	require.NoError(t, err)

	require.Equal(t, 1, slashingKeeper.slashCalls)
	require.Equal(t, consAddr, slashingKeeper.lastSlashConsAddr)
	require.Equal(t, sdkmath.LegacyMustNewDecFromStr("0.01"), slashingKeeper.lastSlashFraction)
	require.Equal(t, int64(123), slashingKeeper.lastSlashPower)
	require.Equal(t, int64(10), slashingKeeper.lastSlashDistributionHeight)
	require.Equal(t, stakingtypes.Infraction_INFRACTION_UNSPECIFIED, slashingKeeper.lastSlashInfraction)

	require.Equal(t, 1, slashingKeeper.jailCalls)
	require.Equal(t, consAddr, slashingKeeper.lastJailConsAddr)

	require.NotNil(t, slashingKeeper.jailUntil)
	require.Equal(t, time.Unix(100, 0).UTC().Add(2*time.Hour), *slashingKeeper.jailUntil)
}

func TestSlashAndJailValidator_DoesNotCallJailWhenAlreadyJailed(t *testing.T) {
	consAddr := sdk.ConsAddress([]byte("consaddr"))
	val := fakeValidator{jailed: true, consAddr: consAddr}

	stakingKeeper := fakeStakingKeeper{val: val, bonded: []stakingtypes.Validator{{}, {}}}
	slashingKeeper := &fakeSlashingKeeper{
		signingInfo: slashingtypes.ValidatorSigningInfo{JailedUntil: time.Unix(0, 0).UTC()},
	}

	sdkCtx := sdk.Context{}.WithBlockTime(time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	err := SlashAndJailValidator(
		ctx,
		stakingKeeper,
		slashingKeeper,
		sdk.ValAddress([]byte("valoper")),
		10,
		123,
		sdkmath.LegacyMustNewDecFromStr("0.01"),
		0,
	)
	require.NoError(t, err)

	require.Equal(t, 1, slashingKeeper.slashCalls)
	require.Equal(t, 0, slashingKeeper.jailCalls)
	require.Nil(t, slashingKeeper.jailUntil)
}

func TestSlashAndJailValidator_JailsWithoutSlashingWhenFractionZero(t *testing.T) {
	consAddr := sdk.ConsAddress([]byte("consaddr"))
	val := fakeValidator{jailed: false, consAddr: consAddr}

	stakingKeeper := fakeStakingKeeper{val: val, bonded: []stakingtypes.Validator{{}, {}}}
	slashingKeeper := &fakeSlashingKeeper{
		signingInfo: slashingtypes.ValidatorSigningInfo{JailedUntil: time.Unix(0, 0).UTC()},
	}

	sdkCtx := sdk.Context{}.WithBlockTime(time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	err := SlashAndJailValidator(
		ctx,
		stakingKeeper,
		slashingKeeper,
		sdk.ValAddress([]byte("valoper")),
		10,
		123,
		sdkmath.LegacyZeroDec(),
		0,
	)
	require.NoError(t, err)

	require.Equal(t, 0, slashingKeeper.slashCalls)
	require.Equal(t, 1, slashingKeeper.jailCalls)
}

func TestSlashAndJailValidator_DoesNotJailSoleBondedValidator(t *testing.T) {
	consAddr := sdk.ConsAddress([]byte("consaddr"))
	val := fakeValidator{jailed: false, consAddr: consAddr}

	// Provide exactly one bonded validator, matching the penalty target's valoper.
	valAddr := sdk.ValAddress([]byte("valoper"))
	stakingKeeper := fakeStakingKeeper{
		val: val,
		bonded: []stakingtypes.Validator{
			{OperatorAddress: valAddr.String()},
		},
	}
	slashingKeeper := &fakeSlashingKeeper{
		signingInfo: slashingtypes.ValidatorSigningInfo{JailedUntil: time.Unix(0, 0).UTC()},
	}

	sdkCtx := sdk.Context{}.WithBlockTime(time.Unix(100, 0).UTC())
	ctx := sdk.WrapSDKContext(sdkCtx)

	err := SlashAndJailValidator(
		ctx,
		stakingKeeper,
		slashingKeeper,
		valAddr,
		10,
		123,
		sdkmath.LegacyMustNewDecFromStr("0.01"),
		2*time.Hour,
	)
	require.NoError(t, err)

	// Slashing still happens.
	require.Equal(t, 1, slashingKeeper.slashCalls)

	// But we must not jail the sole bonded validator (would empty the validator set).
	require.Equal(t, 0, slashingKeeper.jailCalls)
	require.Nil(t, slashingKeeper.jailUntil)
}
