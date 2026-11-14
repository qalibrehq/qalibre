// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TESTNET ONLY. Clearly labelled tokens used to demonstrate and test the Qalibre safety check.
///         Never deploy on mainnet.

/// A plain token whose creator can still mint (a common, real-world caution flag).
contract QalibreTestMintable is ERC20 {
    address public owner;

    constructor(uint256 supply) ERC20("Qalibre Test Dog (testnet)", "QTDOG") {
        owner = msg.sender;
        _mint(msg.sender, supply);
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        _mint(to, amount);
    }
}

/// A honeypot: anyone can buy, but only the creator can sell (transfers into the pool are blocked for others).
contract QalibreTestHoneypot is ERC20 {
    address public owner;
    address public pool;

    constructor(uint256 supply) ERC20("Qalibre Test Honeypot (testnet)", "QTHONEY") {
        owner = msg.sender;
        _mint(msg.sender, supply);
    }

    function setPool(address p) external {
        require(msg.sender == owner, "not owner");
        pool = p;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == pool && pool != address(0) && from != owner) revert("selling disabled");
        super._update(from, to, value);
    }
}

/// A taxed token: 10% of every transfer that is not from or to the creator is burned.
contract QalibreTestTaxed is ERC20 {
    address public owner;

    constructor(uint256 supply) ERC20("Qalibre Test Tax (testnet)", "QTTAX") {
        owner = msg.sender;
        _mint(msg.sender, supply);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && from != owner && to != owner) {
            uint256 tax = value / 10;
            super._update(from, address(0), tax);
            value -= tax;
        }
        super._update(from, to, value);
    }
}

/// A plain token: fixed supply minted once, no owner, no special powers. The counterpart to the three above,
/// showing what the safety check lets through. Almost all of the supply goes into the pool at launch.
contract QalibreTestPlain is ERC20 {
    constructor(uint256 supply) ERC20("Qalibre Test Plain (testnet)", "QTPLAIN") {
        _mint(msg.sender, supply);
    }
}
