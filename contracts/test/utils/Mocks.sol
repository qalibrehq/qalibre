// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISignatureValidator} from "../../src/interfaces/ISignatureValidator.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Burns 1% of every transfer (a "taxed" token).
contract TaxToken is MockERC20 {
    constructor() MockERC20("Tax", "TAX", 18) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = value / 100;
            super._update(from, address(0), tax);
            value -= tax;
        }
        super._update(from, to, value);
    }
}

/// @dev Minimal Uniswap V2-style router with internal constant-product pools and a 0.3% fee.
///      Same math and function signatures as QwapRouter.
contract MockV2Router {
    struct Pool {
        uint256 reserveA;
        uint256 reserveB;
        bool exists;
    }

    mapping(address => mapping(address => Pool)) internal _pools; // keyed by (lower, higher)

    function addPool(address a, address b, uint256 amountA, uint256 amountB) external {
        MockERC20(a).mint(address(this), amountA);
        MockERC20(b).mint(address(this), amountB);
        (address lo, address hi) = a < b ? (a, b) : (b, a);
        (uint256 rLo, uint256 rHi) = a < b ? (amountA, amountB) : (amountB, amountA);
        _pools[lo][hi] = Pool(rLo, rHi, true);
    }

    function reserves(address tokenIn, address tokenOut) public view returns (uint256 rIn, uint256 rOut) {
        (address lo, address hi) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        Pool memory p = _pools[lo][hi];
        require(p.exists, "no pool");
        (rIn, rOut) = tokenIn == lo ? (p.reserveA, p.reserveB) : (p.reserveB, p.reserveA);
    }

    function getAmountOut(uint256 amountIn, uint256 rIn, uint256 rOut) public pure returns (uint256) {
        uint256 inWithFee = amountIn * 997;
        return (inWithFee * rOut) / (rIn * 1000 + inWithFee);
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory a) {
        a = new uint256[](path.length);
        a[0] = amountIn;
        for (uint256 i; i + 1 < path.length; ++i) {
            (uint256 rIn, uint256 rOut) = reserves(path[i], path[i + 1]);
            a[i + 1] = getAmountOut(a[i], rIn, rOut);
        }
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        uint256 before = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 amount = IERC20(path[0]).balanceOf(address(this)) - before;
        for (uint256 i; i + 1 < path.length; ++i) {
            (uint256 rIn, uint256 rOut) = reserves(path[i], path[i + 1]);
            uint256 out = getAmountOut(amount, rIn, rOut);
            _setReserves(path[i], path[i + 1], rIn + amount, rOut - out);
            amount = out;
        }
        require(amount >= amountOutMin, "INSUFFICIENT_OUTPUT_AMOUNT");
        IERC20(path[path.length - 1]).transfer(to, amount);
    }

    function _setReserves(address tokenIn, address tokenOut, uint256 rIn, uint256 rOut) internal {
        (address lo, address hi) = tokenIn < tokenOut ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        if (tokenIn == lo) _pools[lo][hi] = Pool(rIn, rOut, true);
        else _pools[lo][hi] = Pool(rOut, rIn, true);
    }
}

/// @dev Stand-in for a future post-quantum validator: accepts a signature equal to keccak(secret, hash).
contract MockValidator is ISignatureValidator {
    bytes32 public immutable secret;

    constructor(bytes32 s) {
        secret = s;
    }

    function isValidOwnerSignature(address, bytes32 hash, bytes calldata signature) external view returns (bool) {
        return signature.length == 32 && bytes32(signature) == keccak256(abi.encode(secret, hash));
    }
}

/// @dev Minimal WETH9-style wrapped native token.
contract MockWETH is MockERC20 {
    constructor() MockERC20("Wrapped QMS", "WQMS", 18) {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }
}
