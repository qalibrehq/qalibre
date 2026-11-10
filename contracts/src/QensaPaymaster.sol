// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VerifyingPaymaster} from "account-abstraction/samples/VerifyingPaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

/// @title QensaPaymaster
/// @notice Pays gas for users' owner-signed UserOperations (withdraw, change limits, revoke...).
/// @dev The reference eth-infinitism VerifyingPaymaster. The Qensa backend signs a sponsorship for each
///      UserOperation it agrees to pay for. The sponsor key can only approve gas payments; it cannot sign for,
///      or move funds from, any user account. Trades themselves don't need it: the solver pays their gas.
///
///      The owner is passed explicitly: when deployed through a CREATE2 factory, `msg.sender` is the factory,
///      and Ownable would otherwise make the factory the owner (locking the gas deposit forever).
contract QensaPaymaster is VerifyingPaymaster {
    constructor(IEntryPoint entryPoint_, address verifyingSigner_, address owner_)
        VerifyingPaymaster(entryPoint_, verifyingSigner_)
    {
        _transferOwnership(owner_);
    }
}
