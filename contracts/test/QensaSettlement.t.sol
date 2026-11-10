// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./utils/Base.t.sol";
import {QensaAccount} from "../src/QensaAccount.sol";
import {QensaSettlement} from "../src/QensaSettlement.sol";
import {OrderLib} from "../src/libraries/OrderLib.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract QensaSettlementTest is BaseTest {
    uint256 internal constant ALICE = 0xA11CE;
    uint256 internal constant BOB = 0xB0B;

    QensaAccount internal alice;
    QensaAccount internal bob;

    function setUp() public override {
        super.setUp();
        alice = _createFunded(ALICE, 1_000 ether, 0);
        bob = _createFunded(BOB, 0, 1_000 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Happy paths
    // ---------------------------------------------------------------------------------------------

    /// Perfect coincidence of wants: no exchange is touched at all.
    function test_matchesOppositeOrdersWithoutTouchingTheExchange() public {
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 0);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 200 ether, 0);
        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa), false);
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob), false);

        (uint256 rA, uint256 rB) = router.reserves(address(tokA), address(tokB));
        _settle(_prices(2e18), trades, _noInteractions());

        // Flat 0.5% fee when no direct-price reference is given.
        assertEq(tokB.balanceOf(address(alice)), 199 ether);
        assertEq(tokA.balanceOf(address(bob)), 99.5 ether);
        assertEq(tokB.balanceOf(feeRecipient), 1 ether);
        assertEq(tokA.balanceOf(feeRecipient), 0.5 ether);
        assertEq(tokA.balanceOf(address(settlement)), 0);
        assertEq(tokB.balanceOf(address(settlement)), 0);
        (uint256 rA2, uint256 rB2) = router.reserves(address(tokA), address(tokB));
        assertEq(rA, rA2);
        assertEq(rB, rB2);
    }

    /// Partial match: the unmatched part goes to the exchange; both traders still beat swapping directly.
    function test_routesLeftoverAndBeatsDirectSwap() public {
        uint256 directAlice = adapter.quote(address(tokA), address(tokB), 100 ether, "");
        uint256 directBob = adapter.quote(address(tokB), address(tokA), 100 ether, "");

        (uint256 bPerA, uint256 excessA) = _solve(100 ether, 100 ether);
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, directAlice);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 100 ether, directBob);
        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa), true);
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob), true);
        QensaSettlement.Interaction[] memory its = new QensaSettlement.Interaction[](1);
        its[0] = _interaction(address(tokA), address(tokB), excessA);

        _settle(_prices(bPerA), trades, its);

        uint256 gotAlice = tokB.balanceOf(address(alice));
        uint256 gotBob = tokA.balanceOf(address(bob));
        assertGt(gotAlice, directAlice, "alice beats direct");
        assertGt(gotBob, directBob, "bob beats direct");
        // Fee is at most 25% of the improvement (+1 wei rounding per trade).
        uint256 grossAlice = (100 ether * bPerA) / 1e18;
        assertLe(grossAlice - gotAlice, ((grossAlice - directAlice) * SURPLUS_SHARE_BPS) / 10_000 + 1);
        assertLe(tokB.balanceOf(address(settlement)), 0);
        emit log_named_decimal_uint("alice direct (B)", directAlice, 18);
        emit log_named_decimal_uint("alice batched (B)", gotAlice, 18);
        emit log_named_decimal_uint("bob direct (A)", directBob, 18);
        emit log_named_decimal_uint("bob batched (A)", gotBob, 18);
    }

    function test_ownerSignedOrderIgnoresSessionLimits() public {
        // 1500 A exceeds the session's 1000 A per-trade cap, but the owner signed it.
        tokA.mint(address(alice), 1_000 ether);
        tokB.mint(address(bob), 2_000 ether);
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 1_500 ether, 0);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 3_000 ether, 0);
        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(ALICE, 0, oa), false);
        trades[1] = _trade(ob, _sign(BOB, 0, ob), false);
        _settle(_prices(2e18), trades, _noInteractions());
        assertEq(tokB.balanceOf(address(alice)), 2_985 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Things a solver must never be able to do
    // ---------------------------------------------------------------------------------------------

    function test_revert_limitPriceViolated() public {
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 199.5 ether);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 200 ether, 0);
        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa), false);
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob), false);
        vm.expectPartialRevert(QensaSettlement.LimitPriceViolated.selector);
        _settle(_prices(2e18), trades, _noInteractions()); // 200 - 0.5% = 199 < 199.5
    }

    function test_revert_worseThanDirectSwap() public {
        // Alone in the batch at a bad price: the direct-price guarantee must stop it.
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 0);
        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](1);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa), true);
        QensaSettlement.Interaction[] memory its = new QensaSettlement.Interaction[](1);
        its[0] = _interaction(address(tokA), address(tokB), 100 ether);
        vm.expectPartialRevert(QensaSettlement.NotBetterThanDirect.selector);
        _settle(_prices(1.9e18), trades, its);
    }

    function test_revert_solverCannotSkimByUnderpaying() public {
        // Same trades as the leftover test, but the solver quotes a slightly worse price and tries to keep the rest.
        (uint256 bPerA, uint256 excessA) = _solve(100 ether, 100 ether);
        bPerA = (bPerA * 9_990) / 10_000; // 0.1% worse
        excessA = 100 ether - (100 ether * 1e18) / bPerA;
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 0);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 100 ether, 0);
        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa), false);
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob), false);
        QensaSettlement.Interaction[] memory its = new QensaSettlement.Interaction[](1);
        its[0] = _interaction(address(tokA), address(tokB), excessA);
        vm.expectPartialRevert(QensaSettlement.ExcessLeftover.selector);
        _settle(_prices(bPerA), trades, its);
    }

    function test_revert_orderCannotBeFilledTwice() public {
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 0);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 200 ether, 0);
        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa), false);
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob), false);
        _settle(_prices(2e18), trades, _noInteractions());
        vm.expectRevert(QensaSettlement.OrderFilled.selector);
        _settle(_prices(2e18), trades, _noInteractions());
    }

    function test_revert_onlySolver() public {
        (address[] memory toks,) = _tokens();
        vm.expectRevert(QensaSettlement.NotSolver.selector);
        settlement.settle(toks, _prices(2e18), new QensaSettlement.Trade[](0), _noInteractions());
    }

    function test_revert_unapprovedAdapter() public {
        settlement.setAdapter(address(adapter), false);
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 0);
        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](1);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa), false);
        QensaSettlement.Interaction[] memory its = new QensaSettlement.Interaction[](1);
        its[0] = _interaction(address(tokA), address(tokB), 100 ether);
        vm.expectRevert(QensaSettlement.NotAdapter.selector);
        _settle(_prices(1.9e18), trades, its);
    }

    function test_revert_expiredOrder() public {
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 0);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 200 ether, 0);
        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa), false);
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob), false);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(QensaSettlement.OrderExpired.selector);
        _settle(_prices(2e18), trades, _noInteractions());
    }

    function test_revert_unsortedTokens() public {
        (address[] memory toks,) = _tokens();
        (toks[0], toks[1]) = (toks[1], toks[0]);
        vm.prank(solver);
        vm.expectRevert(QensaSettlement.BadTokens.selector);
        settlement.settle(toks, _prices(2e18), new QensaSettlement.Trade[](0), _noInteractions());
    }

    // ---------------------------------------------------------------------------------------------
    // Fee caps and admin
    // ---------------------------------------------------------------------------------------------

    function test_feeCapsAreHardLimits() public {
        vm.expectRevert(QensaSettlement.FeeTooHigh.selector);
        settlement.setFee(51);
        vm.expectRevert(QensaSettlement.FeeTooHigh.selector);
        settlement.setSurplusShare(5_001);
        vm.expectRevert(QensaSettlement.FeeTooHigh.selector);
        new QensaSettlement(address(this), feeRecipient, 51, 0);
    }

    function test_onlyOwnerCanConfigure() public {
        address rando = makeAddr("rando");
        vm.startPrank(rando);
        vm.expectPartialRevert(Ownable.OwnableUnauthorizedAccount.selector);
        settlement.setSolver(rando, true);
        vm.expectPartialRevert(Ownable.OwnableUnauthorizedAccount.selector);
        settlement.setAdapter(rando, true);
        vm.expectPartialRevert(Ownable.OwnableUnauthorizedAccount.selector);
        settlement.setFee(0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Fuzz: whatever the price, a filled order gets >= its minimum and fee <= 1%
    // ---------------------------------------------------------------------------------------------

    function testFuzz_minOutAndFeeCap(uint256 sellA, uint256 bPerA, uint256 minBuy) public {
        sellA = bound(sellA, 1e6, 500 ether);
        bPerA = bound(bPerA, 1e15, 1e21);
        uint256 sellB = (sellA * bPerA) / 1e18;
        vm.assume(sellB > 0 && sellB <= 1_000 ether);
        uint256 gross = (sellA * bPerA) / 1e18;
        minBuy = bound(minBuy, 0, gross);

        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), sellA, minBuy);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), sellB, 0);
        QensaSettlement.Trade[] memory trades = new QensaSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa), false);
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob), false);

        (address[] memory toks,) = _tokens();
        vm.prank(solver);
        try settlement.settle(toks, _prices(bPerA), trades, _noInteractions()) {
            uint256 got = tokB.balanceOf(address(alice));
            assertGe(got, minBuy, "received >= signed minimum");
            assertLe(gross - got, (gross * settlement.MAX_FEE_BPS()) / 10_000 + 1, "fee <= cap");
        } catch (bytes memory reason) {
            // The only acceptable failures: the limit price, or rounding dust above tolerance.
            bytes4 sel = bytes4(reason);
            assertTrue(
                sel == QensaSettlement.LimitPriceViolated.selector || sel == QensaSettlement.ExcessLeftover.selector,
                "unexpected revert"
            );
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Test-side solver: find the uniform price for "sell `a` A" vs "sell `b` B" with the rest on the pool
    // ---------------------------------------------------------------------------------------------

    function _solve(uint256 a, uint256 b) internal view returns (uint256 bPerA, uint256 excessA) {
        (uint256 rA, uint256 rB) = router.reserves(address(tokA), address(tokB));
        uint256 lo = 1e17;
        uint256 hi = 1e20;
        for (uint256 i; i < 200 && lo + 1 < hi; ++i) {
            uint256 mid = (lo + hi) / 2;
            uint256 bobGetsA = (b * 1e18) / mid;
            if (bobGetsA > a) {
                lo = mid;
                continue;
            }
            uint256 x = a - bobGetsA;
            uint256 bAvailable = b + router.getAmountOut(x, rA, rB);
            uint256 aliceGross = (a * mid) / 1e18;
            if (aliceGross <= bAvailable) lo = mid;
            else hi = mid;
        }
        bPerA = lo;
        excessA = a - (b * 1e18) / bPerA;
    }
}
