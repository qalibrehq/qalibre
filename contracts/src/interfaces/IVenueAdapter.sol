// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice A plug-in that lets the settlement contract trade on one external venue (a DEX, a launchpad, ...).
/// @dev The settlement contract transfers `amountIn` of `tokenIn` to the adapter, then calls `swap`.
///      The adapter must send the output to `recipient`. The settlement contract measures what it actually
///      received, so a buggy or malicious adapter can at worst make a batch revert; every order's
///      minimum output is still enforced by the settlement contract.
interface IVenueAdapter {
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata data
    ) external;

    /// @notice What `amountIn` would buy on this venue right now. Returns 0 if no route.
    function quote(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata data)
        external
        view
        returns (uint256 amountOut);
}
