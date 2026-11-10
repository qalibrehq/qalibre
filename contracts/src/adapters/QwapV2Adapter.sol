// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IVenueAdapter} from "../interfaces/IVenueAdapter.sol";

/// @dev Subset of QwapRouter (a Uniswap V2 Router02 fork, verified on testnet.qmsscan.io at
///      0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619; 0.3% pool fee).
interface IQwapRouter {
    function factory() external view returns (address);
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory);
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;
}

/// @title QwapV2Adapter
/// @notice Venue plug-in for QWAP. `data` is either empty (direct pair) or an abi-encoded address[] path.
contract QwapV2Adapter is IVenueAdapter {
    using SafeERC20 for IERC20;

    IQwapRouter public immutable router;
    address public immutable settlement;

    error NotSettlement();
    error BadPath();

    constructor(IQwapRouter router_, address settlement_) {
        router = router_;
        settlement = settlement_;
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address recipient,
        bytes calldata data
    ) external {
        if (msg.sender != settlement) revert NotSettlement();
        address[] memory path = _path(tokenIn, tokenOut, data);
        // Use what actually arrived (handles transfer-taxed tokens); the settlement measures the output.
        uint256 amount = IERC20(tokenIn).balanceOf(address(this));
        if (amount > amountIn) amount = amountIn;
        IERC20(tokenIn).forceApprove(address(router), amount);
        router.swapExactTokensForTokensSupportingFeeOnTransferTokens(
            amount, minAmountOut, path, recipient, block.timestamp
        );
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn, bytes calldata data)
        external
        view
        returns (uint256)
    {
        address[] memory path = _path(tokenIn, tokenOut, data);
        try router.getAmountsOut(amountIn, path) returns (uint256[] memory amounts) {
            return amounts[amounts.length - 1];
        } catch {
            return 0;
        }
    }

    function _path(address tokenIn, address tokenOut, bytes calldata data)
        internal
        pure
        returns (address[] memory path)
    {
        if (data.length == 0) {
            path = new address[](2);
            path[0] = tokenIn;
            path[1] = tokenOut;
        } else {
            path = abi.decode(data, (address[]));
            if (path.length < 2 || path[0] != tokenIn || path[path.length - 1] != tokenOut) revert BadPath();
        }
    }
}
