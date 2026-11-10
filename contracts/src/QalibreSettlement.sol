// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {OrderLib} from "./libraries/OrderLib.sol";
import {IQalibreAccount} from "./interfaces/IQalibreAccount.sol";
import {IVenueAdapter} from "./interfaces/IVenueAdapter.sol";

/// @title QalibreSettlement (v2)
/// @notice Batch auction with uniform clearing prices.
///
/// A whitelisted solver submits a batch: tokens with one clearing price each, the signed orders, and the
/// venue swaps needed for whatever the orders could not match against each other.
///
/// Guarantees enforced on-chain, whatever the solver does:
///   1. Uniform prices. Every buyer of a token in a batch receives the same rate: sellAmount * p[sell] / p[buy],
///      scaled by the same surplus multiplier (see 4).
///   2. Never worse than a direct swap. For every trade the contract itself quotes the canonical reference venue
///      (fixed here, changeable only through a public 48-hour delay) before any batch swap. A trade settles only if
///      it receives at least that amount before fees. Session-key orders without a reference price are rejected.
///   3. Limit prices. Every order receives at least its signed minBuyAmount after every fee.
///   4. Nothing is kept. Whatever the venue legs return beyond the clearing amounts is distributed to that
///      token's buyers pro rata. The contract keeps only sub-wei rounding dust.
///   5. Fees. Qalibre's fee is taken only from the improvement over the direct quote:
///      min(feeBps of the trade, surplusShareBps of the improvement), hard-capped at 0.5% and 50%.
///      The network fee is passed through at cost: at most what the user signed, and at most 0.5% of the trade.
///   6. Verifiable receipts. Each trade emits the direct quote next to what the trader received.
///
/// Governance. The owner cannot move tokens. Adding a solver or adapter, changing the reference venue, or raising a
/// fee takes effect only after ADMIN_DELAY and is announced by an event first. Removing a solver or adapter, and
/// lowering a fee, take effect immediately (those can only make users safer).
contract QalibreSettlement is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Trade {
        uint256 sellTokenIndex;
        uint256 buyTokenIndex;
        OrderLib.Order order;
        bytes signature;
        uint256 networkFee; // in buyToken, at cost
    }

    struct Interaction {
        address adapter;
        uint256 tokenInIndex;
        uint256 tokenOutIndex;
        uint256 amountIn;
        uint256 minAmountOut;
        bytes data;
    }

    /// @dev Per-trade working memory.
    struct Fill {
        bytes32 digest;
        uint256 gross;
        uint256 direct;
    }

    uint256 public constant MAX_FEE_BPS = 50; // 0.50%
    uint256 public constant MAX_SURPLUS_SHARE_BPS = 5_000; // 50% of the improvement
    uint256 public constant MAX_NETWORK_FEE_BPS = 50; // 0.50%
    uint256 public constant ADMIN_DELAY = 2 days;
    uint256 internal constant BPS = 10_000;
    uint8 internal constant SIG_KIND_OWNER = 0;

    uint256 public feeBps;
    uint256 public surplusShareBps;
    address public feeRecipient;
    IVenueAdapter public referenceVenue;
    bool public bootstrapped;

    mapping(address => bool) public isSolver;
    mapping(address => bool) public isAdapter;
    mapping(bytes32 => bool) public filled;
    uint256 public batchCount;

    // Pending, delayed changes: target => earliest execution time.
    mapping(address => uint256) public pendingSolver;
    mapping(address => uint256) public pendingAdapter;
    address public pendingReference;
    uint256 public pendingReferenceEta;
    uint256 public pendingFeeBps;
    uint256 public pendingSurplusShareBps;
    uint256 public pendingFeeEta;

    event TradeSettled(
        uint256 indexed batchId,
        address indexed account,
        bytes32 indexed orderDigest,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 buyAmount,
        uint256 fee,
        uint256 networkFee,
        uint256 directQuote
    );
    event InteractionExecuted(
        uint256 indexed batchId, address indexed adapter, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut
    );
    event BatchSettled(uint256 indexed batchId, address indexed solver, uint256 trades, uint256 interactions);
    event SurplusDistributed(uint256 indexed batchId, address indexed token, uint256 amount);
    event DustSwept(uint256 indexed batchId, address indexed token, uint256 amount);
    event ChangeScheduled(bytes32 indexed what, address indexed target, uint256 value, uint256 eta);
    event SolverSet(address indexed solver, bool allowed);
    event AdapterSet(address indexed adapter, bool allowed);
    event ReferenceVenueSet(address indexed venue);
    event FeesSet(uint256 feeBps, uint256 surplusShareBps);
    event FeeRecipientChanged(address recipient);

    error NotSolver();
    error NotAdapter();
    error FeeTooHigh();
    error ZeroAddress();
    error BadTokens();
    error BadPrices();
    error TokenMismatch();
    error OrderExpired();
    error OrderFilled();
    error WrongAmountReceived();
    error NoReferencePrice(bytes32 orderDigest);
    error NotBetterThanDirect(bytes32 orderDigest, uint256 batchAmount, uint256 directAmount);
    error NetworkFeeTooHigh(bytes32 orderDigest);
    error LimitPriceViolated(bytes32 orderDigest, uint256 buyAmount, uint256 minBuyAmount);
    error InteractionUnderdelivered(uint256 index, uint256 received, uint256 minAmountOut);
    error InsufficientProceeds(address token, uint256 available, uint256 owed);
    error ExcessLeftover(address token, uint256 leftover);
    error BalanceDecreased(address token);
    error NotReady(uint256 eta);
    error NothingScheduled();
    error AlreadyBootstrapped();

    constructor(address initialOwner, address feeRecipient_, uint256 feeBps_, uint256 surplusShareBps_)
        Ownable(initialOwner)
    {
        _setFeeRecipient(feeRecipient_);
        _setFees(feeBps_, surplusShareBps_);
    }

    /// @notice One-time setup, before any batch can settle. After this, every addition is delayed.
    function bootstrap(address[] calldata solvers, address[] calldata adapters, IVenueAdapter referenceVenue_)
        external
        onlyOwner
    {
        if (bootstrapped) revert AlreadyBootstrapped();
        if (address(referenceVenue_) == address(0)) revert ZeroAddress();
        bootstrapped = true;
        for (uint256 i; i < solvers.length; ++i) _setSolver(solvers[i], true);
        for (uint256 i; i < adapters.length; ++i) _setAdapter(adapters[i], true);
        referenceVenue = referenceVenue_;
        emit ReferenceVenueSet(address(referenceVenue_));
    }

    // ---------------------------------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------------------------------

    function domainSeparator() external view returns (bytes32) {
        return OrderLib.domainSeparator(address(this));
    }

    function orderDigest(OrderLib.Order calldata order) external view returns (bytes32) {
        return OrderLib.digest(address(this), order);
    }

    /// @param tokens        All tokens touched by the batch, strictly ascending by address.
    /// @param prices        One clearing price per token, in any common unit (only ratios matter).
    /// @param trades        Signed orders, filled completely (fill-or-kill).
    /// @param interactions  Venue swaps for the net imbalance that could not be matched internally.
    function settle(
        address[] calldata tokens,
        uint256[] calldata prices,
        Trade[] calldata trades,
        Interaction[] calldata interactions
    ) external nonReentrant returns (uint256 batchId) {
        if (!isSolver[msg.sender]) revert NotSolver();
        uint256 n = tokens.length;
        if (prices.length != n) revert BadPrices();
        for (uint256 i; i < n; ++i) {
            if (prices[i] == 0) revert BadPrices();
            if (i == 0 ? tokens[0] == address(0) : tokens[i] <= tokens[i - 1]) revert BadTokens();
        }

        batchId = ++batchCount;
        uint256[] memory startBalance = new uint256[](n);
        for (uint256 i; i < n; ++i) startBalance[i] = IERC20(tokens[i]).balanceOf(address(this));

        // 1. Pull sell tokens, take the reference quote, compute each order's uniform-price amount.
        Fill[] memory fills = new Fill[](trades.length);
        uint256[] memory owedGross = new uint256[](n);
        for (uint256 t; t < trades.length; ++t) {
            fills[t] = _pull(tokens, prices, trades[t]);
            owedGross[trades[t].buyTokenIndex] += fills[t].gross;
        }

        // 2. Trade the net imbalance on external venues.
        for (uint256 k; k < interactions.length; ++k) {
            _interact(batchId, k, tokens, interactions[k]);
        }

        // 3. What each token's buyers can be paid: everything that arrived, never less than owed.
        uint256[] memory surplus = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 bal = IERC20(tokens[i]).balanceOf(address(this));
            if (bal < startBalance[i]) revert BalanceDecreased(tokens[i]);
            uint256 available = bal - startBalance[i];
            if (owedGross[i] == 0) {
                if (available > trades.length) revert ExcessLeftover(tokens[i], available);
            } else {
                if (available < owedGross[i]) revert InsufficientProceeds(tokens[i], available, owedGross[i]);
                surplus[i] = available - owedGross[i];
                if (surplus[i] > 0) emit SurplusDistributed(batchId, tokens[i], surplus[i]);
            }
        }

        // 4. Pay every trader: uniform amount + pro-rata surplus, checked against direct and limit.
        uint256[] memory feeTotals = new uint256[](n);
        for (uint256 t; t < trades.length; ++t) {
            uint256 b = trades[t].buyTokenIndex;
            feeTotals[b] += _pay(batchId, trades[t], fills[t], surplus[b], owedGross[b]);
        }

        // 5. Fees to the fee recipient, then sweep sub-wei rounding dust.
        address recipient = feeRecipient;
        for (uint256 i; i < n; ++i) {
            IERC20 token = IERC20(tokens[i]);
            if (feeTotals[i] > 0) token.safeTransfer(recipient, feeTotals[i]);
            uint256 bal = token.balanceOf(address(this));
            if (bal < startBalance[i]) revert BalanceDecreased(tokens[i]);
            uint256 dust = bal - startBalance[i];
            if (dust > trades.length) revert ExcessLeftover(tokens[i], dust);
            if (dust > 0) {
                token.safeTransfer(recipient, dust);
                emit DustSwept(batchId, tokens[i], dust);
            }
        }

        emit BatchSettled(batchId, msg.sender, trades.length, interactions.length);
    }

    function _pull(address[] calldata tokens, uint256[] calldata prices, Trade calldata tr)
        internal
        returns (Fill memory f)
    {
        OrderLib.Order calldata o = tr.order;
        if (tokens[tr.sellTokenIndex] != o.sellToken || tokens[tr.buyTokenIndex] != o.buyToken) revert TokenMismatch();
        if (o.sellToken == o.buyToken) revert TokenMismatch();
        if (block.timestamp > o.validTo) revert OrderExpired();

        f.digest = OrderLib.digest(address(this), o);
        if (filled[f.digest]) revert OrderFilled();
        filled[f.digest] = true;

        // Mandatory reference quote, before any batch swap moves the price.
        try referenceVenue.quote(o.sellToken, o.buyToken, o.sellAmount, "") returns (uint256 q) {
            f.direct = q;
        } catch {}
        // Only the owner may trade without a reference price (for example a token with no pool yet).
        if (f.direct == 0 && (tr.signature.length == 0 || uint8(tr.signature[0]) != SIG_KIND_OWNER)) {
            revert NoReferencePrice(f.digest);
        }

        IERC20 sell = IERC20(o.sellToken);
        uint256 before = sell.balanceOf(address(this));
        IQalibreAccount(o.account).authorizeOrder(o, tr.signature);
        if (sell.balanceOf(address(this)) - before != o.sellAmount) revert WrongAmountReceived();

        f.gross = Math.mulDiv(o.sellAmount, prices[tr.sellTokenIndex], prices[tr.buyTokenIndex]);
    }

    function _pay(uint256 batchId, Trade calldata tr, Fill memory f, uint256 surplus, uint256 owedGross)
        internal
        returns (uint256 fees)
    {
        OrderLib.Order calldata o = tr.order;
        uint256 amount = f.gross + (surplus == 0 ? 0 : Math.mulDiv(surplus, f.gross, owedGross));
        if (amount < f.direct) revert NotBetterThanDirect(f.digest, amount, f.direct);

        uint256 fee = (amount * feeBps) / BPS;
        if (f.direct > 0) {
            uint256 improvementFee = ((amount - f.direct) * surplusShareBps) / BPS;
            if (improvementFee < fee) fee = improvementFee;
        }
        uint256 nf = tr.networkFee;
        if (nf > o.maxNetworkFee || nf * BPS > amount * MAX_NETWORK_FEE_BPS) revert NetworkFeeTooHigh(f.digest);

        uint256 net = amount - fee - nf;
        if (net < o.minBuyAmount) revert LimitPriceViolated(f.digest, net, o.minBuyAmount);
        if (net > 0) IERC20(o.buyToken).safeTransfer(o.account, net);
        emit TradeSettled(batchId, o.account, f.digest, o.sellToken, o.buyToken, o.sellAmount, net, fee, nf, f.direct);
        return fee + nf;
    }

    function _interact(uint256 batchId, uint256 k, address[] calldata tokens, Interaction calldata it) internal {
        if (!isAdapter[it.adapter]) revert NotAdapter();
        address tokenIn = tokens[it.tokenInIndex];
        address tokenOut = tokens[it.tokenOutIndex];
        if (tokenIn == tokenOut) revert TokenMismatch();

        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).safeTransfer(it.adapter, it.amountIn);
        IVenueAdapter(it.adapter).swap(tokenIn, tokenOut, it.amountIn, it.minAmountOut, address(this), it.data);
        uint256 received = IERC20(tokenOut).balanceOf(address(this)) - before;
        if (received < it.minAmountOut) revert InteractionUnderdelivered(k, received, it.minAmountOut);
        emit InteractionExecuted(batchId, it.adapter, tokenIn, tokenOut, it.amountIn, received);
    }

    // ---------------------------------------------------------------------------------------------
    // Governance: additions are delayed and announced; removals are immediate. No function moves tokens.
    // ---------------------------------------------------------------------------------------------

    function scheduleSolver(address solver) external onlyOwner {
        if (solver == address(0)) revert ZeroAddress();
        pendingSolver[solver] = block.timestamp + ADMIN_DELAY;
        emit ChangeScheduled("solver", solver, 1, pendingSolver[solver]);
    }

    function executeSolver(address solver) external onlyOwner {
        _ready(pendingSolver[solver]);
        delete pendingSolver[solver];
        _setSolver(solver, true);
    }

    function removeSolver(address solver) external onlyOwner {
        delete pendingSolver[solver];
        _setSolver(solver, false);
    }

    function scheduleAdapter(address adapter) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        pendingAdapter[adapter] = block.timestamp + ADMIN_DELAY;
        emit ChangeScheduled("adapter", adapter, 1, pendingAdapter[adapter]);
    }

    function executeAdapter(address adapter) external onlyOwner {
        _ready(pendingAdapter[adapter]);
        delete pendingAdapter[adapter];
        _setAdapter(adapter, true);
    }

    function removeAdapter(address adapter) external onlyOwner {
        delete pendingAdapter[adapter];
        _setAdapter(adapter, false);
    }

    function scheduleReferenceVenue(address venue) external onlyOwner {
        if (venue == address(0)) revert ZeroAddress();
        pendingReference = venue;
        pendingReferenceEta = block.timestamp + ADMIN_DELAY;
        emit ChangeScheduled("reference", venue, 0, pendingReferenceEta);
    }

    function executeReferenceVenue() external onlyOwner {
        if (pendingReference == address(0)) revert NothingScheduled();
        _ready(pendingReferenceEta);
        referenceVenue = IVenueAdapter(pendingReference);
        delete pendingReference;
        delete pendingReferenceEta;
        emit ReferenceVenueSet(address(referenceVenue));
    }

    /// @notice Lowering either fee applies at once; raising either is delayed.
    function setFees(uint256 newFeeBps, uint256 newShareBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS || newShareBps > MAX_SURPLUS_SHARE_BPS) revert FeeTooHigh();
        if (newFeeBps <= feeBps && newShareBps <= surplusShareBps) {
            _setFees(newFeeBps, newShareBps);
            delete pendingFeeEta;
        } else {
            pendingFeeBps = newFeeBps;
            pendingSurplusShareBps = newShareBps;
            pendingFeeEta = block.timestamp + ADMIN_DELAY;
            emit ChangeScheduled("fees", address(0), (newFeeBps << 128) | newShareBps, pendingFeeEta);
        }
    }

    function executeFees() external onlyOwner {
        if (pendingFeeEta == 0) revert NothingScheduled();
        _ready(pendingFeeEta);
        delete pendingFeeEta;
        _setFees(pendingFeeBps, pendingSurplusShareBps);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        _setFeeRecipient(recipient);
    }

    function _ready(uint256 eta) internal view {
        if (eta == 0) revert NothingScheduled();
        if (block.timestamp < eta) revert NotReady(eta);
    }

    function _setSolver(address solver, bool allowed) internal {
        isSolver[solver] = allowed;
        emit SolverSet(solver, allowed);
    }

    function _setAdapter(address adapter, bool allowed) internal {
        isAdapter[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    function _setFees(uint256 newFeeBps, uint256 newShareBps) internal {
        if (newFeeBps > MAX_FEE_BPS || newShareBps > MAX_SURPLUS_SHARE_BPS) revert FeeTooHigh();
        feeBps = newFeeBps;
        surplusShareBps = newShareBps;
        emit FeesSet(newFeeBps, newShareBps);
    }

    function _setFeeRecipient(address recipient) internal {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientChanged(recipient);
    }
}
