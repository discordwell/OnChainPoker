export const OCP_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function owner() view returns (address)",
  "function mint(address to, uint256 amount)"
] as const;

export const POKER_VAULT_ABI = [
  "function token() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function nonces(address) view returns (uint256)",
  "function handApplied(bytes32) view returns (bool)",
  "function computeResultHash(bytes32 handId, address[] players, int256[] deltas) view returns (bytes32)",
  "function applyHandResultWithSignatures(bytes32 handId, address[] players, int256[] deltas, uint256 deadline, bytes[] signatures)",
  "event Deposit(address indexed player, uint256 amount)",
  "event Withdraw(address indexed player, uint256 amount)",
  "event HandResultApplied(bytes32 indexed handId, bytes32 indexed resultHash, address indexed submitter, address[] players, int256[] deltas)"
] as const;

