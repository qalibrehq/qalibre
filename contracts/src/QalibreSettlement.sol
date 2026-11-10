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

/// @title QalibreSettlement
/// @notice Batch auction with uniform clearing prices.
///
/// A whitelisted solver submits a batch: a list of tokens with one clearing price each, the signed orders,
/// and the venue swaps (interactions) needed for whatever the orders could not match against each other.
///
/// Guarantees enforced on-chain, whatever the solver does:
///   1. Uniform prices: every order receives sellAmount * price[sell] / price[buy] (minus the fee),
///      so all traders on the same pair in the same batch get the same rate.
///   2. Limit prices: every order receives at least its signed minBuyAmount, after fees. Otherwise the batch reverts.
///   3. Fee cap: the protocol fee can never exceed MAX_FEE_BPS (0.5%) of the trade.
///   3b. Never worse than direct: when a trade carries a reference venue, the contract quotes what the order
///      would have received swapping directly on that venue's pool (before any batch swap moves the price).
///      The trade reverts unless the batch price is at least as good, and the fee is taken ONLY from the
///      improvement: fee = min(feeBps of the trade, surplusShareBps of the improvement). Qalibre earns only
///      when it saves the user money, and the user always ends up at or above the direct price.
///   4. No skimming: after the batch, the contract may keep at most MAX_DUST_BPS (0.01%) of payouts as
///      rounding dust. Every other token it received has been paid out to traders.
///   5. Verifiable receipts: if asked, the contract quotes the direct venue price for each order BEFORE any
///      batch swaps, and emits it next to the price the trader actually got.
///
/// The owner can only: set the fee (<= cap), the fee recipient, the solver list and the adapter list.
/// The owner has no function to move tokens.
contract QalibreSettlement is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Trade {
        uint256 sellTokenIndex;
        uint256 buyTokenIndex;
        OrderLib.Order order;
        bytes signature;
        address refAdapter; // venue for the "swap directly instead" comparison (direct pool); zero = skip
    }

    struct Interaction {
        address adapter;
        uint256 tokenInIndex;
        uint256 tokenOutIndex;
        uint256 amountIn;
        uint256 minAmountOut;
        bytes data;
    }

    uint256 public constant MAX_FEE_BPS = 50; // 0.50% hard ceiling
    uint256 public constant MAX_DUST_BPS = 1; // 0.01%
    uint256 public constant MAX_SURPLUS_SHARE_BPS = 5_000; // at most half of the savings
    uint256 internal constant BPS = 10_000;

    uint256 public feeBps;
    uint256 public surplusShareBps;
    address public feeRecipient;
    mapping(address => bool) public isSolver;
    mapping(address => bool) public isAdapter;
    mapping(bytes32 => bool) public filled;
    uint256 public batchCount;

    event TradeSettled(
        uint256 indexed batchId,
        address indexed account,
        bytes32 indexed orderDigest,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 buyAmount,
        uint256 fee,
        uint256 directQuote
    );
    event InteractionExecuted(
        uint256 indexed batchId, address indexed adapter, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut
    );
    event BatchSettled(uint256 indexed batchId, address indexed solver, uint256 trades, uint256 interactions);
    event DustSwept(uint256 indexed batchId, address indexed token, uint256 amount);
    event FeeChanged(uint256 feeBps);
    event SurplusShareChanged(uint256 surplusShareBps);
    event FeeRecipientChanged(address recipient);
    event SolverSet(address indexed solver, bool allowed);
    event AdapterSet(address indexed adapter, bool allowed);

    error NotSolver();
    error NotAdapter();
    error FeeTooHigh();
    error NotBetterThanDirect(bytes32 orderDigest, uint256 batchAmount, uint256 directAmount);
    error ZeroAddress();
    error BadTokens();
    error BadPrices();
    error TokenMismatch();
    error OrderExpired();
    error OrderFilled();
    error WrongAmountReceived();
    error LimitPriceViolated(bytes32 orderDigest, uint256 buyAmount, uint256 minBuyAmount);
    error InteractionUnderdelivered(uint256 index, uint256 received, uint256 minAmountOut);
    error ExcessLeftover(address token, uint256 leftover, uint256 allowed);
    error BalanceDecreased(address token);

    constructor(address initialOwner, address feeRecipient_, uint256 feeBps_, uint256 surplusShareBps_)
        Ownable(initialOwner)
    {
        _setFeeRecipient(feeRecipient_);
        _setFee(feeBps_);
        _setSurplusShare(surplusShareBps_);
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
        uint256[] memory startBalance = _balances(tokens);
        uint256[] memory owed = new uint256[](n);
        uint256[] memory fees = new uint256[](n);
        uint256[] memory payout = new uint256[](trades.length);
        uint256 fee_ = feeBps;

        // 1. Pull every order's sell tokens, compute its uniform-price payout and check its limit.
        for (uint256 t; t < trades.length; ++t) {
            payout[t] = _pull(batchId, tokens, prices, trades[t], fee_, owed, fees);
        }

        // 2. Trade the net imbalance on external venues.
        for (uint256 k; k < interactions.length; ++k) {
            _interact(batchId, k, tokens, interactions[k]);
        }

        // 3. Pay every trader. Proceeds always go to the order's own account.
        for (uint256 t; t < trades.length; ++t) {
            if (payout[t] > 0) {
                IERC20(trades[t].order.buyToken).safeTransfer(trades[t].order.account, payout[t]);
            }
        }

        // 4. Pay fees, then prove nothing beyond rounding dust stayed behind.
        address recipient = feeRecipient;
        for (uint256 i; i < n; ++i) {
            IERC20 token = IERC20(tokens[i]);
            if (fees[i] > 0) token.safeTransfer(recipient, fees[i]);
            uint256 endBalance = token.balanceOf(address(this));
            if (endBalance < startBalance[i]) revert BalanceDecreased(tokens[i]);
            uint256 leftover = endBalance - startBalance[i];
            uint256 allowed = (owed[i] * MAX_DUST_BPS) / BPS + trades.length;
            if (leftover > allowed) revert ExcessLeftover(tokens[i], leftover, allowed);
            if (leftover > 0) {
                token.safeTransfer(recipient, leftover);
                emit DustSwept(batchId, tokens[i], leftover);
            }
        }

        emit BatchSettled(batchId, msg.sender, trades.length, interactions.length);
    }

    function _pull(
        uint256 batchId,
        address[] calldata tokens,
        uint256[] calldata prices,
        Trade calldata tr,
        uint256 fee_,
        uint256[] memory owed,
        uint256[] memory fees
    ) internal returns (uint256 net) {
        OrderLib.Order calldata o = tr.order;
        if (tokens[tr.sellTokenIndex] != o.sellToken || tokens[tr.buyTokenIndex] != o.buyToken) {
            revert TokenMismatch();
        }
        if (o.sellToken == o.buyToken) revert TokenMismatch();
        if (block.timestamp > o.validTo) revert OrderExpired();

        bytes32 digest = OrderLib.digest(address(this), o);
        if (filled[digest]) revert OrderFilled();
        filled[digest] = true;

        // Direct-swap reference quote, taken before any batch swap moves the venue's price.
        uint256 directQuote;
        if (tr.refAdapter != address(0)) {
            if (!isAdapter[tr.refAdapter]) revert NotAdapter();
            try IVenueAdapter(tr.refAdapter).quote(o.sellToken, o.buyToken, o.sellAmount, "") returns (
                uint256 q
            ) {
                directQuote = q;
            } catch {}
        }

        IERC20 sell = IERC20(o.sellToken);
        uint256 before = sell.balanceOf(address(this));
        IQalibreAccount(o.account).authorizeOrder(o, tr.signature);
        if (sell.balanceOf(address(this)) - before != o.sellAmount) revert WrongAmountReceived();

        uint256 gross = Math.mulDiv(o.sellAmount, prices[tr.sellTokenIndex], prices[tr.buyTokenIndex]);
        uint256 fee = (gross * fee_) / BPS;
        if (tr.refAdapter != address(0)) {
            if (gross < directQuote) revert NotBetterThanDirect(digest, gross, directQuote);
            uint256 surplusFee = ((gross - directQuote) * surplusShareBps) / BPS;
            if (surplusFee < fee) fee = surplusFee;
        }
        net = gross - fee;
        if (net < o.minBuyAmount) revert LimitPriceViolated(digest, net, o.minBuyAmount);

        owed[tr.buyTokenIndex] += net;
        fees[tr.buyTokenIndex] += fee;
        emit TradeSettled(batchId, o.account, digest, o.sellToken, o.buyToken, o.sellAmount, net, fee, directQuote);
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

    function _balances(address[] calldata tokens) internal view returns (uint256[] memory b) {
        b = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; ++i) {
            b[i] = IERC20(tokens[i]).balanceOf(address(this));
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Admin (cannot touch funds)
    // ---------------------------------------------------------------------------------------------

    function setFee(uint256 newFeeBps) external onlyOwner {
        _setFee(newFeeBps);
    }

    function setSurplusShare(uint256 newShareBps) external onlyOwner {
        _setSurplusShare(newShareBps);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        _setFeeRecipient(recipient);
    }

    function setSolver(address solver, bool allowed) external onlyOwner {
        isSolver[solver] = allowed;
        emit SolverSet(solver, allowed);
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        isAdapter[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    function _setFee(uint256 newFeeBps) internal {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = newFeeBps;
        emit FeeChanged(newFeeBps);
    }

    function _setSurplusShare(uint256 newShareBps) internal {
        if (newShareBps > MAX_SURPLUS_SHARE_BPS) revert FeeTooHigh();
        surplusShareBps = newShareBps;
        emit SurplusShareChanged(newShareBps);
    }

    function _setFeeRecipient(address recipient) internal {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientChanged(recipient);
    }
}
