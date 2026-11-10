// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Pluggable owner-signature check for a Qlear account.
/// @dev This is the post-quantum upgrade slot: when QMS ships PQ signatures, an owner installs a
///      validator implementing the new scheme. Only the account owner can install or remove one.
interface ISignatureValidator {
    /// @return true if `signature` is a valid owner signature over `hash` for `account`.
    function isValidOwnerSignature(address account, bytes32 hash, bytes calldata signature)
        external
        view
        returns (bool);
}
