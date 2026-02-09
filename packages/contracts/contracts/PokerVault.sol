// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title PokerVault
/// @notice Escrows an ERC-20 and keeps an internal ledger for poker settlements.
/// @dev Hidden-information poker isn't feasible purely on-chain; this contract is a minimal settlement layer
///      suitable for off-chain dealing with on-chain escrow.
contract PokerVault is Ownable, EIP712 {
    using SafeERC20 for IERC20;

    error EmptyPlayers();
    error LengthMismatch();
    error DeadlineExpired(uint256 deadline);
    error HandAlreadyApplied(bytes32 handId);
    error DuplicatePlayer(address player);
    error InvalidSignature(address expectedSigner, address recoveredSigner);
    error NonZeroSum();
    error InsufficientBalance(address player, uint256 have, uint256 need);

    bytes32 public constant HAND_RESULT_APPROVAL_TYPEHASH =
        keccak256("HandResultApproval(bytes32 resultHash,uint256 nonce,uint256 deadline)");

    IERC20 public immutable token;

    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => bool) public handApplied;

    event Deposit(address indexed player, uint256 amount);
    event Withdraw(address indexed player, uint256 amount);
    event HandResultApplied(
        bytes32 indexed handId,
        bytes32 indexed resultHash,
        address indexed submitter,
        address[] players,
        int256[] deltas
    );

    constructor(address initialOwner, IERC20 token_) Ownable(initialOwner) EIP712("PokerVault", "1") {
        token = token_;
    }

    function deposit(uint256 amount) external {
        uint256 beforeBal = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - beforeBal;
        balanceOf[msg.sender] += received;
        emit Deposit(msg.sender, received);
    }

    function withdraw(uint256 amount) external {
        uint256 bal = balanceOf[msg.sender];
        if (bal < amount) revert InsufficientBalance(msg.sender, bal, amount);
        balanceOf[msg.sender] = bal - amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount);
    }

    function computeResultHash(bytes32 handId, address[] calldata players, int256[] calldata deltas)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(handId, address(this), address(token), players, deltas));
    }

    /// @notice Apply a per-player delta for a completed hand. Deltas must sum to zero.
    /// @dev Requires a signature from every player in `players` over the exact `(handId, players, deltas)` payload.
    function applyHandResultWithSignatures(
        bytes32 handId,
        address[] calldata players,
        int256[] calldata deltas,
        uint256 deadline,
        bytes[] calldata signatures
    ) external {
        if (handApplied[handId]) revert HandAlreadyApplied(handId);
        if (block.timestamp > deadline) revert DeadlineExpired(deadline);
        if (players.length != deltas.length || players.length != signatures.length) revert LengthMismatch();
        if (players.length == 0) revert EmptyPlayers();

        // n is small (poker table), O(n^2) duplicate detection is fine.
        for (uint256 i = 0; i < players.length; i++) {
            for (uint256 j = i + 1; j < players.length; j++) {
                if (players[i] == players[j]) revert DuplicatePlayer(players[i]);
            }
        }

        bytes32 resultHash = computeResultHash(handId, players, deltas);

        int256 sum;
        for (uint256 i = 0; i < players.length; i++) {
            address p = players[i];
            int256 d = deltas[i];
            sum += d;

            uint256 nonce = nonces[p];
            bytes32 structHash = keccak256(abi.encode(HAND_RESULT_APPROVAL_TYPEHASH, resultHash, nonce, deadline));
            bytes32 digest = _hashTypedDataV4(structHash);
            address recovered = ECDSA.recover(digest, signatures[i]);
            if (recovered != p) revert InvalidSignature(p, recovered);
            nonces[p] = nonce + 1;

            if (d < 0) {
                uint256 ud = uint256(-d);
                uint256 bal = balanceOf[p];
                if (bal < ud) revert InsufficientBalance(p, bal, ud);
                balanceOf[p] = bal - ud;
            } else if (d > 0) {
                balanceOf[p] += uint256(d);
            }
        }

        if (sum != 0) revert NonZeroSum();
        handApplied[handId] = true;
        emit HandResultApplied(handId, resultHash, msg.sender, players, deltas);
    }
}
