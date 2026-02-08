// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title PokerVault
/// @notice Escrows an ERC-20 and keeps an internal ledger for poker settlements.
/// @dev Hidden-information poker isn't feasible purely on-chain; this contract is a minimal settlement layer
///      suitable for off-chain dealing with on-chain escrow.
contract PokerVault is Ownable {
    using SafeERC20 for IERC20;

    error LengthMismatch();
    error NonZeroSum();
    error InsufficientBalance(address player, uint256 have, uint256 need);

    IERC20 public immutable token;

    mapping(address => uint256) public balanceOf;

    event Deposit(address indexed player, uint256 amount);
    event Withdraw(address indexed player, uint256 amount);
    event HandResultApplied(address indexed operator, address[] players, int256[] deltas);

    constructor(address initialOwner, IERC20 token_) Ownable(initialOwner) {
        token = token_;
    }

    function deposit(uint256 amount) external {
        token.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        emit Deposit(msg.sender, amount);
    }

    function withdraw(uint256 amount) external {
        uint256 bal = balanceOf[msg.sender];
        if (bal < amount) revert InsufficientBalance(msg.sender, bal, amount);
        balanceOf[msg.sender] = bal - amount;
        token.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount);
    }

    /// @notice Apply a per-player delta for a completed hand. Deltas must sum to zero.
    /// @dev Owner-only for now; upgrade path is to require N-of-M signatures from players.
    function applyHandResult(address[] calldata players, int256[] calldata deltas) external onlyOwner {
        if (players.length != deltas.length) revert LengthMismatch();

        int256 sum;
        for (uint256 i = 0; i < players.length; i++) {
            address p = players[i];
            int256 d = deltas[i];
            sum += d;

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
        emit HandResultApplied(msg.sender, players, deltas);
    }
}

