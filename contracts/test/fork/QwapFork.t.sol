// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {QensaAccount} from "../../src/QensaAccount.sol";
import {QensaAccountFactory} from "../../src/QensaAccountFactory.sol";
import {QensaSettlement} from "../../src/QensaSettlement.sol";
import {QwapV2Adapter, IQwapRouter} from "../../src/adapters/QwapV2Adapter.sol";
import {OrderLib} from "../../src/libraries/OrderLib.sol";

/// @notice Runs against a fork of the live QMS testnet and the real QWAP pools.
///         `QMS_RPC_URL=https://rpc.testnet.qms.finance forge test --match-path "test/fork/*"`
contract QwapForkTest is Test {
    // Verified on testnet.qmsscan.io (2026-11-10).
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant QWAP_ROUTER = 0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619;
    address constant WQMS = 0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34;
    address constant USDC = 0xDfF68E53a0A8275212927c12017f5aB5f1842a04; // the USDC in QWAP's WQMS/USDC pool

    uint256 constant SESSION_PK = 0xBEEF;
    uint256 constant ALICE = 0xA11CE;
    uint256 constant BOB = 0xB0B;

    QensaSettlement settlement;
    QensaAccountFactory factory;
    QwapV2Adapter adapter;
    QensaAccount alice;
    QensaAccount bob;
    address solver = makeAddr("solver");
    address feeRecipient = makeAddr("fee");
    bool enabled;

    function setUp() public {
        string memory rpc = vm.envOr("QMS_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        enabled = true;

        settlement = new QensaSettlement(address(this), feeRecipient, 20, 2_000); // launch settings
        factory = new QensaAccountFactory(IEntryPoint(ENTRY_POINT), address(settlement));
        adapter = new QwapV2Adapter(IQwapRouter(QWAP_ROUTER), address(settlement));
        settlement.setSolver(solver, true);
        settlement.setAdapter(address(adapter), true);

        alice = _account(ALICE);
        bob = _account(BOB);
        deal(WQMS, address(alice), 100 ether);
        deal(USDC, address(bob), 1_000_000e6);
    }

    modifier onlyFork() {
        if (!enabled) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_fork_adapterQuoteMatchesQwap() public onlyFork {
        address[] memory path = new address[](2);
        path[0] = WQMS;
        path[1] = USDC;
        uint256[] memory amounts = IQwapRouter(QWAP_ROUTER).getAmountsOut(1 ether, path);
        assertEq(adapter.quote(WQMS, USDC, 1 ether, ""), amounts[1]);
        assertGt(amounts[1], 0);
        emit log_named_decimal_uint("QWAP: 1 WQMS buys USDC", amounts[1], 6);
    }

    /// One trader alone: everything goes to QWAP. They get exactly the direct price and pay no Qensa fee.
    function test_fork_loneTradeGetsDirectPriceAndPaysNoFee() public onlyFork {
        uint256 direct = adapter.quote(WQMS, USDC, 10 ether, "");
        OrderLib.Order memory o = _order(alice, WQMS, USDC, 10 ether, (direct * 99) / 100);

        (address[] memory toks, uint256 iW, uint256 iU) = _tokens();
        uint256[] memory prices = new uint256[](2);
        prices[iW] = direct; // gross = 10e18 * direct / 10e18 = direct
        prices[iU] = 10 ether;

        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](1);
        trades[0] = _trade(o, iW, iU);
        QensaSettlement.Interaction[] memory its = new QensaSettlement.Interaction[](1);
        its[0] = QensaSettlement.Interaction(address(adapter), iW, iU, 10 ether, direct, "");

        vm.prank(solver);
        settlement.settle(toks, prices, trades, its);
        assertEq(IERC20(USDC).balanceOf(address(alice)), direct);
        assertEq(IERC20(USDC).balanceOf(feeRecipient), 0);
    }

    /// Two opposite traders: matched against each other, only the leftover hits QWAP. Both beat QWAP.
    function test_fork_matchedTradersBothBeatQwap() public onlyFork {
        uint256 sellW = 50 ether;
        uint256 directAlice = adapter.quote(WQMS, USDC, sellW, "");
        uint256 sellU = directAlice / 2; // Bob buys about half of what Alice sells
        uint256 directBob = adapter.quote(USDC, WQMS, sellU, "");

        // Find the uniform price r (USDC units per 1e18 WQMS wei) that clears both orders plus the pool leg.
        uint256 lo = 1;
        uint256 hi = (directAlice * 1e18) / sellW * 2;
        for (uint256 i; i < 256 && lo + 1 < hi; ++i) {
            uint256 mid = (lo + hi) / 2;
            uint256 bobGetsW = (sellU * 1e18) / mid;
            if (bobGetsW > sellW) {
                lo = mid;
                continue;
            }
            uint256 usdcAvailable = sellU + adapter.quote(WQMS, USDC, sellW - bobGetsW, "");
            if ((sellW * mid) / 1e18 <= usdcAvailable) lo = mid;
            else hi = mid;
        }
        uint256 r = lo;
        uint256 excessW = sellW - (sellU * 1e18) / r;

        (address[] memory toks, uint256 iW, uint256 iU) = _tokens();
        uint256[] memory prices = new uint256[](2);
        prices[iW] = r;
        prices[iU] = 1e18;

        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](2);
        trades[0] = _trade(_order(alice, WQMS, USDC, sellW, directAlice), iW, iU);
        trades[1] = _trade(_order(bob, USDC, WQMS, sellU, directBob), iU, iW);
        QensaSettlement.Interaction[] memory its = new QensaSettlement.Interaction[](1);
        its[0] = QensaSettlement.Interaction(address(adapter), iW, iU, excessW, 0, "");

        vm.prank(solver);
        settlement.settle(toks, prices, trades, its);

        uint256 gotAlice = IERC20(USDC).balanceOf(address(alice));
        uint256 gotBob = IERC20(WQMS).balanceOf(address(bob));
        assertGe(gotAlice, directAlice);
        assertGt(gotBob, directBob);
        emit log_named_decimal_uint("Alice direct on QWAP (USDC)", directAlice, 6);
        emit log_named_decimal_uint("Alice with Qensa     (USDC)", gotAlice, 6);
        emit log_named_decimal_uint("Bob direct on QWAP   (WQMS)", directBob, 18);
        emit log_named_decimal_uint("Bob with Qensa       (WQMS)", gotBob, 18);
        emit log_named_decimal_uint("Qensa fee (USDC)", IERC20(USDC).balanceOf(feeRecipient), 6);
    }

    // ---------------------------------------------------------------------------------------------

    function _account(uint256 pk) internal returns (QensaAccount) {
        QensaAccount.SessionSetup memory s;
        s.key = vm.addr(SESSION_PK);
        s.validUntil = uint48(block.timestamp + 7 days);
        s.limits = new QensaAccount.TokenLimit[](2);
        s.limits[0] = QensaAccount.TokenLimit(WQMS, 1_000 ether, 10_000 ether);
        s.limits[1] = QensaAccount.TokenLimit(USDC, 1_000_000e6, 10_000_000e6);
        s.buyTokens = new address[](2);
        s.buyTokens[0] = WQMS;
        s.buyTokens[1] = USDC;
        QensaAccountFactory.Setup memory setup = QensaAccountFactory.Setup(vm.addr(pk), 0, s);
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(factory.setupHash(setup)));
        return factory.createAccount(setup, abi.encodePacked(r, sg, v));
    }

    function _order(QensaAccount a, address sell, address buy, uint256 amount, uint256 minBuy)
        internal
        view
        returns (OrderLib.Order memory)
    {
        return OrderLib.Order(address(a), sell, buy, amount, minBuy, uint64(block.timestamp + 1 hours), amount);
    }

    function _trade(OrderLib.Order memory o, uint256 sellIdx, uint256 buyIdx)
        internal
        view
        returns (QensaSettlement.Trade memory t)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, settlement.orderDigest(o));
        t = QensaSettlement.Trade(sellIdx, buyIdx, o, abi.encodePacked(uint8(1), r, s, v), address(adapter));
    }

    function _tokens() internal pure returns (address[] memory toks, uint256 iW, uint256 iU) {
        toks = new address[](2);
        if (WQMS < USDC) (toks[0], toks[1], iW, iU) = (WQMS, USDC, 0, 1);
        else (toks[0], toks[1], iW, iU) = (USDC, WQMS, 1, 0);
    }
}
