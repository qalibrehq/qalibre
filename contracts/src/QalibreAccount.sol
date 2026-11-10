// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseAccount} from "account-abstraction/core/BaseAccount.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {SIG_VALIDATION_FAILED, SIG_VALIDATION_SUCCESS} from "account-abstraction/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import {OrderLib} from "./libraries/OrderLib.sol";
import {IQalibreAccount} from "./interfaces/IQalibreAccount.sol";
import {ISignatureValidator} from "./interfaces/ISignatureValidator.sol";

interface IWrappedNative {
    function deposit() external payable;
}

/// @title QalibreAccount
/// @notice A non-custodial ERC-4337 smart account owned by one user.
///
/// Who can do what:
///   OWNER       - everything: execute any call, withdraw, change limits, revoke the session key,
///                 swap the signature validator (post-quantum upgrade slot). Can act through the
///                 ERC-4337 EntryPoint (gasless via a paymaster) OR by calling this contract directly,
///                 so the user never depends on the Qalibre app to reach their funds.
///   SESSION KEY - (held by the Qalibre backend) can ONLY sign trade orders. Those orders are executed
///                 by the trusted settlement contract, are capped per trade and per day, limited to
///                 approved tokens, expire, and always pay proceeds back into THIS account.
///                 A session key can never sign a UserOperation, call `execute`, or withdraw.
///   SETTLEMENT  - can only call `authorizeOrder` with a correctly signed order.
///
/// There is no admin, no upgrade proxy and no pause. Qalibre cannot move user funds.
contract QalibreAccount is BaseAccount, IERC1271, IQalibreAccount, Initializable {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------------------

    struct TokenLimit {
        address token;
        uint128 perTrade; // max sellAmount in one order; 0 = token not allowed to be sold
        uint128 perDay; // max total sellAmount per UTC day
    }

    struct SessionSetup {
        address key;
        uint48 validUntil;
        bool anyBuyToken; // if false, only tokens in `buyTokens` may be bought
        TokenLimit[] limits;
        address[] buyTokens;
    }

    struct Limit {
        uint128 perTrade;
        uint128 perDay;
    }

    /// @dev First byte of an order signature.
    uint8 public constant SIG_KIND_OWNER = 0;
    uint8 public constant SIG_KIND_SESSION = 1;

    // ---------------------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------------------

    IEntryPoint private immutable _entryPoint;
    /// @notice Wrapped native QMS. Native QMS (e.g. from the faucet) is wrapped automatically when an order needs it.
    address public immutable wrappedNative;

    bytes32 internal constant MESSAGE_TYPEHASH = keccak256("QalibreMessage(bytes32 hash)");

    /// @notice The user. Signs UserOperations (ECDSA) unless a custom validator is installed.
    address public owner;
    /// @notice Optional owner-signature validator (post-quantum upgrade slot). Zero = ECDSA by `owner`.
    ISignatureValidator public validator;
    /// @notice The only contract allowed to execute this account's orders.
    address public settlement;

    address public sessionKey;
    uint48 public sessionValidUntil;
    bool public sessionAnyBuyToken;
    /// @dev Bumped on every session change so old limits/allowlists/spend can never be reused.
    uint32 public sessionEpoch;

    mapping(uint32 epoch => mapping(address token => Limit)) internal _limits;
    mapping(uint32 epoch => mapping(address token => mapping(uint256 day => uint256))) public spent;
    mapping(uint32 epoch => mapping(address token => bool)) internal _buyAllowed;
    mapping(bytes32 orderDigest => bool) public usedOrder;

    // ---------------------------------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------------------------------

    event Initialized(address indexed owner, address indexed settlement);
    event SessionSet(address indexed key, uint48 validUntil, bool anyBuyToken, uint32 epoch);
    event SessionRevoked(uint32 epoch);
    event TokenLimitSet(uint32 indexed epoch, address indexed token, uint128 perTrade, uint128 perDay);
    event BuyTokenSet(uint32 indexed epoch, address indexed token, bool allowed);
    event ValidatorChanged(address indexed validator);
    event OwnerChanged(address indexed owner);
    event SettlementChanged(address indexed settlement);
    event OrderAuthorized(bytes32 indexed digest, uint8 kind, address sellToken, uint256 sellAmount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotAuthorized();
    error NotSettlement();
    error WrongAccount();
    error OrderExpired();
    error OrderReplayed();
    error SameToken();
    error BadSignature();
    error BadSignatureKind();
    error SessionInactive();
    error SellTokenNotAllowed();
    error BuyTokenNotAllowed();
    error PerTradeLimit();
    error PerDayLimit();
    error InvalidLimit();
    error NoOwner();
    error ZeroAddress();
    error CallFailed(bytes reason);

    // ---------------------------------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------------------------------

    constructor(IEntryPoint anEntryPoint, address wrappedNative_) {
        _entryPoint = anEntryPoint;
        wrappedNative = wrappedNative_;
        _disableInitializers();
    }

    /// @dev Called once by the factory, atomically with deployment, after it verified the owner's signature.
    function initialize(address anOwner, address aSettlement, SessionSetup calldata session) external initializer {
        if (anOwner == address(0) || aSettlement == address(0)) revert ZeroAddress();
        owner = anOwner;
        settlement = aSettlement;
        emit Initialized(anOwner, aSettlement);
        if (session.key != address(0)) _setSession(session);
    }

    receive() external payable {}

    function entryPoint() public view override returns (IEntryPoint) {
        return _entryPoint;
    }

    /// @dev Owner authority: the EntryPoint (only after an owner-signed UserOperation was validated),
    ///      the owner calling directly, or the account calling itself (from `execute`).
    modifier onlyOwnerAuth() {
        if (
            msg.sender != address(_entryPoint) && msg.sender != address(this)
                && (msg.sender != owner || owner == address(0))
        ) revert NotAuthorized();
        _;
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-4337: owner-signed UserOperations only
    // ---------------------------------------------------------------------------------------------

    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        override
        returns (uint256)
    {
        bytes32 hash = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        return _isValidOwnerSignature(hash, userOp.signature) ? SIG_VALIDATION_SUCCESS : SIG_VALIDATION_FAILED;
    }

    /// @notice ERC-1271. Only the owner's signature is accepted; session keys never are.
    /// @dev The owner signs `replaySafeHash(hash)`, which binds the signature to this account and chain, so a
    ///      signature for one account can never be replayed against another account with the same owner.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _isValidOwnerSignature(replaySafeHash(hash), signature)
            ? IERC1271.isValidSignature.selector
            : bytes4(0xffffffff);
    }

    function replaySafeHash(bytes32 hash) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Qalibre Account"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(MESSAGE_TYPEHASH, hash))));
    }

    function _isValidOwnerSignature(bytes32 hash, bytes calldata signature) internal view returns (bool) {
        ISignatureValidator v = validator;
        if (address(v) != address(0)) {
            return v.isValidOwnerSignature(address(this), hash, signature);
        }
        address o = owner;
        if (o == address(0)) return false;
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && recovered == o;
    }

    // ---------------------------------------------------------------------------------------------
    // Owner actions
    // ---------------------------------------------------------------------------------------------

    function execute(address target, uint256 value, bytes calldata data) external onlyOwnerAuth {
        _call(target, value, data);
    }

    function executeBatch(address[] calldata targets, uint256[] calldata values, bytes[] calldata datas)
        external
        onlyOwnerAuth
    {
        uint256 n = targets.length;
        if (values.length != n || datas.length != n) revert InvalidLimit();
        for (uint256 i; i < n; ++i) {
            _call(targets[i], values[i], datas[i]);
        }
    }

    /// @notice Send funds to the owner. `token == address(0)` withdraws native QMS.
    function withdrawToOwner(address token, uint256 amount) external onlyOwnerAuth {
        address o = owner;
        if (o == address(0)) revert NoOwner();
        if (token == address(0)) {
            (bool ok, bytes memory r) = payable(o).call{value: amount}("");
            if (!ok) revert CallFailed(r);
        } else {
            IERC20(token).safeTransfer(o, amount);
        }
        emit Withdrawn(token, o, amount);
    }

    /// @notice Replace the trading session entirely (new key, new limits). Old limits stop applying.
    function setSession(SessionSetup calldata session) external onlyOwnerAuth {
        _setSession(session);
    }

    function setTokenLimit(address token, uint128 perTrade, uint128 perDay) external onlyOwnerAuth {
        _setLimit(sessionEpoch, token, perTrade, perDay);
    }

    function setBuyTokenAllowed(address token, bool allowed) external onlyOwnerAuth {
        _buyAllowed[sessionEpoch][token] = allowed;
        emit BuyTokenSet(sessionEpoch, token, allowed);
    }

    function setAnyBuyToken(bool any) external onlyOwnerAuth {
        sessionAnyBuyToken = any;
        emit SessionSet(sessionKey, sessionValidUntil, any, sessionEpoch);
    }

    /// @notice Immediately and permanently disable the current session key.
    function revokeSession() external onlyOwnerAuth {
        sessionKey = address(0);
        sessionValidUntil = 0;
        sessionAnyBuyToken = false;
        unchecked {
            ++sessionEpoch;
        }
        emit SessionRevoked(sessionEpoch);
    }

    /// @notice Install (or remove, with address(0)) a custom owner-signature validator,
    ///         e.g. a post-quantum scheme once QMS supports one.
    function setValidator(ISignatureValidator newValidator) external onlyOwnerAuth {
        validator = newValidator;
        emit ValidatorChanged(address(newValidator));
    }

    /// @notice Change the owner address. Clearing it is only allowed while a custom validator is installed,
    ///         so the account can never become ownerless.
    function setOwner(address newOwner) external onlyOwnerAuth {
        if (newOwner == address(0) && address(validator) == address(0)) revert ZeroAddress();
        owner = newOwner;
        emit OwnerChanged(newOwner);
    }

    /// @notice Point the account at a different settlement contract (e.g. a new Qalibre version). Owner only.
    function setSettlement(address newSettlement) external onlyOwnerAuth {
        if (newSettlement == address(0)) revert ZeroAddress();
        settlement = newSettlement;
        emit SettlementChanged(newSettlement);
    }

    // ---------------------------------------------------------------------------------------------
    // Trading
    // ---------------------------------------------------------------------------------------------

    /// @inheritdoc IQalibreAccount
    function authorizeOrder(OrderLib.Order calldata order, bytes calldata signature) external {
        if (msg.sender != settlement) revert NotSettlement();
        if (order.account != address(this)) revert WrongAccount();
        if (block.timestamp > order.validTo) revert OrderExpired();
        if (order.sellToken == order.buyToken) revert SameToken();
        if (signature.length == 0) revert BadSignature();

        // The digest is computed here, bound to msg.sender (the settlement contract), never taken on trust.
        bytes32 digest = OrderLib.digest(msg.sender, order);
        if (usedOrder[digest]) revert OrderReplayed();
        usedOrder[digest] = true;

        uint8 kind = uint8(signature[0]);
        bytes calldata sig = signature[1:];
        if (kind == SIG_KIND_OWNER) {
            if (!_isValidOwnerSignature(digest, sig)) revert BadSignature();
        } else if (kind == SIG_KIND_SESSION) {
            _checkSessionOrder(digest, sig, order);
        } else {
            revert BadSignatureKind();
        }

        // Native QMS counts as tradeable QMS: wrap only the shortfall, only for this order.
        if (order.sellToken == wrappedNative && wrappedNative != address(0)) {
            uint256 have = IERC20(wrappedNative).balanceOf(address(this));
            if (have < order.sellAmount) {
                uint256 need = order.sellAmount - have;
                if (address(this).balance >= need) IWrappedNative(wrappedNative).deposit{value: need}();
            }
        }
        IERC20(order.sellToken).safeTransfer(msg.sender, order.sellAmount);
        emit OrderAuthorized(digest, kind, order.sellToken, order.sellAmount);
    }

    function _checkSessionOrder(bytes32 digest, bytes calldata sig, OrderLib.Order calldata order) internal {
        address key = sessionKey;
        if (key == address(0) || block.timestamp > sessionValidUntil) revert SessionInactive();
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError || recovered != key) revert BadSignature();

        uint32 epoch = sessionEpoch;
        Limit memory l = _limits[epoch][order.sellToken];
        if (l.perTrade == 0) revert SellTokenNotAllowed();
        if (order.sellAmount > l.perTrade) revert PerTradeLimit();

        uint256 day = block.timestamp / 1 days;
        uint256 newSpent = spent[epoch][order.sellToken][day] + order.sellAmount;
        if (newSpent > l.perDay) revert PerDayLimit();
        spent[epoch][order.sellToken][day] = newSpent;

        if (!sessionAnyBuyToken && !_buyAllowed[epoch][order.buyToken]) revert BuyTokenNotAllowed();
    }

    // ---------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------

    function tokenLimit(address token) external view returns (uint128 perTrade, uint128 perDay) {
        Limit memory l = _limits[sessionEpoch][token];
        return (l.perTrade, l.perDay);
    }

    function spentToday(address token) external view returns (uint256) {
        return spent[sessionEpoch][token][block.timestamp / 1 days];
    }

    function isBuyTokenAllowed(address token) external view returns (bool) {
        return sessionAnyBuyToken || _buyAllowed[sessionEpoch][token];
    }

    function sessionActive() external view returns (bool) {
        return sessionKey != address(0) && block.timestamp <= sessionValidUntil;
    }

    // ---------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------

    function _setSession(SessionSetup calldata s) internal {
        if (s.key == address(0)) revert ZeroAddress();
        uint32 epoch;
        unchecked {
            epoch = ++sessionEpoch;
        }
        sessionKey = s.key;
        sessionValidUntil = s.validUntil;
        sessionAnyBuyToken = s.anyBuyToken;
        for (uint256 i; i < s.limits.length; ++i) {
            _setLimit(epoch, s.limits[i].token, s.limits[i].perTrade, s.limits[i].perDay);
        }
        for (uint256 i; i < s.buyTokens.length; ++i) {
            _buyAllowed[epoch][s.buyTokens[i]] = true;
            emit BuyTokenSet(epoch, s.buyTokens[i], true);
        }
        emit SessionSet(s.key, s.validUntil, s.anyBuyToken, epoch);
    }

    function _setLimit(uint32 epoch, address token, uint128 perTrade, uint128 perDay) internal {
        if (token == address(0)) revert ZeroAddress();
        if (perTrade > perDay) revert InvalidLimit();
        _limits[epoch][token] = Limit(perTrade, perDay);
        emit TokenLimitSet(epoch, token, perTrade, perDay);
    }

    function _call(address target, uint256 value, bytes calldata data) internal {
        (bool ok, bytes memory r) = target.call{value: value}(data);
        if (!ok) revert CallFailed(r);
    }
}
