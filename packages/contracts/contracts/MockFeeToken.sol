// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only fee-on-transfer token. Used to validate vault accounting.
contract MockFeeToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("MockFeeToken", "MFEE") {
        require(feeBps_ <= 10_000, "fee too high");
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        // Charge a fee on regular transfers (including transferFrom), but not on mint/burn.
        if (from != address(0) && to != address(0) && feeBps != 0) {
            uint256 fee = (value * feeBps) / 10_000;
            uint256 sendAmount = value - fee;
            super._update(from, to, sendAmount);
            if (fee != 0) super._update(from, address(0), fee); // burn fee
        } else {
            super._update(from, to, value);
        }
    }
}

