// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title OnChainPoker token (platform + in-game utility)
/// @dev Simple owner-mintable ERC-20. Use with PokerVault for escrowed gameplay.
contract OCPToken is ERC20, ERC20Permit, Ownable {
    constructor(address initialOwner, uint256 initialSupply)
        ERC20("OnChainPoker", "OCP")
        ERC20Permit("OnChainPoker")
        Ownable(initialOwner)
    {
        _mint(initialOwner, initialSupply);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}

