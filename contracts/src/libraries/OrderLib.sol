// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title OrderLib
/// @notice The EIP-712 order every Qlear trade is built from.
/// @dev Both the account and the settlement contract compute the digest with this library,
///      so the account never has to trust a hash handed to it by someone else.
library OrderLib {
    /// @param account       The Qlear account selling tokens. Proceeds always return to this account.
    /// @param sellToken     Token the account gives.
    /// @param buyToken      Token the account receives.
    /// @param sellAmount    Exact amount of sellToken (fill-or-kill).
    /// @param minBuyAmount  Minimum buyToken the account must receive AFTER fees. Never violated.
    /// @param validTo       Unix timestamp after which the order is dead.
    /// @param nonce         Free-form unique value so identical orders hash differently.
    struct Order {
        address account;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 minBuyAmount;
        uint64 validTo;
        uint256 nonce;
    }

    bytes32 internal constant ORDER_TYPEHASH = keccak256(
        "Order(address account,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint64 validTo,uint256 nonce)"
    );

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant NAME_HASH = keccak256("Qlear Settlement");
    bytes32 internal constant VERSION_HASH = keccak256("1");

    function domainSeparator(address settlement) internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, settlement));
    }

    function structHash(Order calldata o) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ORDER_TYPEHASH, o.account, o.sellToken, o.buyToken, o.sellAmount, o.minBuyAmount, o.validTo, o.nonce
            )
        );
    }

    function digest(address settlement, Order calldata o) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(settlement), structHash(o)));
    }
}
