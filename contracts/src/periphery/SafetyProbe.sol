// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IWrappedNative {
    function deposit() external payable;
}

interface IRouterLike {
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title SafetyProbe
/// @notice Simulation-only: buys a token with wrapped native QMS and immediately tries to sell it back, reporting
///         what happened. Never deployed. The backend injects this bytecode at a throwaway address inside an
///         eth_call (state override), so nothing is spent and nothing is written to the chain.
/// @dev A clean result is evidence, not proof: some scam tokens only block selling for certain addresses or later
///      in time. The app says so in plain words.
contract SafetyProbe {
    struct Result {
        bool buyOk;
        bool sellOk;
        uint256 expectedBuy; // what a normal token would give for the buy
        uint256 bought; // what actually arrived (lower => buy tax)
        uint256 expectedSell; // what selling `bought` should give back
        uint256 soldFor; // what actually came back (lower => sell tax)
        bytes buyError;
        bytes sellError;
    }

    function probe(address router, address wrappedNative, address token) external payable returns (Result memory r) {
        IWrappedNative(wrappedNative).deposit{value: msg.value}();
        IERC20(wrappedNative).approve(router, msg.value);

        address[] memory buyPath = new address[](2);
        buyPath[0] = wrappedNative;
        buyPath[1] = token;
        try IRouterLike(router).getAmountsOut(msg.value, buyPath) returns (uint256[] memory a) {
            r.expectedBuy = a[1];
        } catch {
            return r; // no pool
        }

        uint256 before = IERC20(token).balanceOf(address(this));
        try IRouterLike(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            msg.value, 0, buyPath, address(this), block.timestamp
        ) {
            r.buyOk = true;
        } catch (bytes memory e) {
            r.buyError = e;
            return r;
        }
        r.bought = IERC20(token).balanceOf(address(this)) - before;
        if (r.bought == 0) return r;

        address[] memory sellPath = new address[](2);
        sellPath[0] = token;
        sellPath[1] = wrappedNative;
        try IERC20(token).approve(router, r.bought) {} catch (bytes memory e) {
            r.sellError = e;
            return r;
        }
        try IRouterLike(router).getAmountsOut(r.bought, sellPath) returns (uint256[] memory a) {
            r.expectedSell = a[1];
        } catch {}
        uint256 wBefore = IERC20(wrappedNative).balanceOf(address(this));
        try IRouterLike(router).swapExactTokensForTokensSupportingFeeOnTransferTokens(
            r.bought, 0, sellPath, address(this), block.timestamp
        ) {
            r.sellOk = true;
        } catch (bytes memory e) {
            r.sellError = e;
        }
        r.soldFor = IERC20(wrappedNative).balanceOf(address(this)) - wBefore;
    }
}
