// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {VerifyingPaymaster} from "account-abstraction/samples/VerifyingPaymaster.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

/// @title QlearPaymaster
/// @notice Pays gas for users' owner-signed UserOperations (withdraw, change limits, revoke...).
/// @dev The reference eth-infinitism VerifyingPaymaster, unchanged. The Qlear backend signs a sponsorship
///      for each UserOperation it agrees to pay for. The sponsor key can only approve gas payments; it cannot
///      sign for, or move funds from, any user account. Trades themselves don't need it: the solver pays
///      their gas when it submits a batch.
contract QlearPaymaster is VerifyingPaymaster {
    constructor(IEntryPoint entryPoint_, address verifyingSigner_) VerifyingPaymaster(entryPoint_, verifyingSigner_) {}
}
