// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {QensaAccount} from "./QensaAccount.sol";

/// @title QensaAccountFactory
/// @notice Deploys one QensaAccount per (owner, salt) at a predictable address.
/// @dev Accounts are minimal (EIP-1167) clones: NOT upgradeable proxies. Nobody can change their code.
///      Creation requires the owner's signature over the full setup (settlement + session key + limits),
///      so no one can create an account for a user with a session key the user did not approve.
contract QensaAccountFactory {
    struct Setup {
        address owner;
        uint256 salt;
        QensaAccount.SessionSetup session;
    }

    QensaAccount public immutable accountImplementation;
    address public immutable settlement;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    error BadOwnerSignature();

    constructor(IEntryPoint entryPoint, address settlement_) {
        accountImplementation = new QensaAccount(entryPoint);
        settlement = settlement_;
    }

    /// @notice The hash the owner signs (personal_sign / EIP-191) to approve account creation.
    function setupHash(Setup calldata s) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), settlement, keccak256(abi.encode(s))));
    }

    function createAccount(Setup calldata s, bytes calldata ownerSignature) external returns (QensaAccount account) {
        address predicted = getAddress(s.owner, s.salt);
        if (predicted.code.length > 0) return QensaAccount(payable(predicted));

        bytes32 h = MessageHashUtils.toEthSignedMessageHash(setupHash(s));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(h, ownerSignature);
        if (err != ECDSA.RecoverError.NoError || signer != s.owner || s.owner == address(0)) {
            revert BadOwnerSignature();
        }

        account = QensaAccount(payable(Clones.cloneDeterministic(address(accountImplementation), _salt(s.owner, s.salt))));
        account.initialize(s.owner, settlement, s.session);
        emit AccountCreated(address(account), s.owner, s.salt);
    }

    function getAddress(address owner, uint256 salt) public view returns (address) {
        return Clones.predictDeterministicAddress(address(accountImplementation), _salt(owner, salt), address(this));
    }

    function _salt(address owner, uint256 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }
}
