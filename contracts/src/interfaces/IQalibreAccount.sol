// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OrderLib} from "../libraries/OrderLib.sol";

interface IQalibreAccount {
    /// @notice Called only by the account's trusted settlement contract. Checks the order's signature
    ///         and the session limits, then transfers exactly `order.sellAmount` to the settlement contract.
    function authorizeOrder(OrderLib.Order calldata order, bytes calldata signature) external;
}
