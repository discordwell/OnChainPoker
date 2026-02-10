package params

const (
	// AppName is the human-readable name used in on-chain config/genesis.
	AppName = "OnChainPoker"

	// BinaryName is the name of the Cosmos SDK binary produced by this module.
	BinaryName = "ocpd"

	// Bech32Prefix is the Bech32 prefix for account addresses on this chain.
	Bech32Prefix = "ocp"

	// BaseDenom is the on-chain base denomination (the smallest unit).
	// Example: 1 ocp == 1_000_000 uocp (if you choose 6 decimals in metadata).
	BaseDenom = "uocp"

	// DisplayDenom is the optional human/display denomination.
	DisplayDenom = "ocp"

	// DefaultChainID is a suggested chain-id for local dev/testnets.
	// `ocpd init --chain-id <...>` can override this.
	DefaultChainID = "onchainpoker-1"

	// EnvPrefix is the environment variable prefix used by the CLI/config system.
	// Example: OCPD_HOME, OCPD_CHAIN_ID, etc.
	EnvPrefix = "OCPD"
)
