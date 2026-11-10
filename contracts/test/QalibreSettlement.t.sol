// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./utils/Base.t.sol";
import {QalibreAccount} from "../src/QalibreAccount.sol";
import {QalibreSettlement} from "../src/QalibreSettlement.sol";
import {IVenueAdapter} from "../src/interfaces/IVenueAdapter.sol";
import {OrderLib} from "../src/libraries/OrderLib.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract QalibreSettlementTest is BaseTest {
    uint256 internal constant ALICE = 0xA11CE;
    uint256 internal constant BOB = 0xB0B;

    QalibreAccount internal alice;
    QalibreAccount internal bob;

    function setUp() public override {
        super.setUp();
        alice = _createFunded(ALICE, 1_000 ether, 0);
        bob = _createFunded(BOB, 0, 1_000 ether);
    }

    function _pair(uint256 aSell, uint256 bSell) internal view returns (QalibreSettlement.Trade[] memory trades) {
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), aSell, 0);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), bSell, 0);
        trades = new QalibreSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa));
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob));
    }

    // ---------------------------------------------------------------------------------------------
    // Happy paths
    // ---------------------------------------------------------------------------------------------

    function test_perfectMatchBeatsDirectAndChargesOnlyFromSavings() public {
        uint256 directA = _direct(address(tokA), address(tokB), 100 ether);
        uint256 directB = _direct(address(tokB), address(tokA), 200 ether);
        (uint256 rA, uint256 rB) = router.reserves(address(tokA), address(tokB));

        _settle(_prices(2e18), _pair(100 ether, 200 ether), _noInteractions());

        uint256 gotA = tokB.balanceOf(address(alice));
        uint256 gotB = tokA.balanceOf(address(bob));
        assertGt(gotA, directA);
        assertGt(gotB, directB);
        // Fee is 25% of the improvement, below the 0.5% cap here.
        assertEq(200 ether - gotA, ((200 ether - directA) * SURPLUS_SHARE_BPS) / 10_000);
        // The exchange was not touched.
        (uint256 rA2, uint256 rB2) = router.reserves(address(tokA), address(tokB));
        assertEq(rA, rA2);
        assertEq(rB, rB2);
        assertEq(tokA.balanceOf(address(settlement)), 0);
        assertEq(tokB.balanceOf(address(settlement)), 0);
    }

    function test_partialMatchRoutesLeftoverAndBothBeatDirect() public {
        uint256 directA = _direct(address(tokA), address(tokB), 100 ether);
        uint256 directB = _direct(address(tokB), address(tokA), 100 ether);
        (uint256 bPerA, uint256 excessA) = _solve(100 ether, 100 ether);
        QalibreSettlement.Interaction[] memory its = new QalibreSettlement.Interaction[](1);
        its[0] = _interaction(address(tokA), address(tokB), excessA);

        _settle(_prices(bPerA), _pair(100 ether, 100 ether), its);

        assertGt(tokB.balanceOf(address(alice)), directA);
        assertGt(tokA.balanceOf(address(bob)), directB);
        assertLe(tokA.balanceOf(address(settlement)), 0);
        assertLe(tokB.balanceOf(address(settlement)), 0);
    }

    /// v2: the solver keeps a safety margin on the exchange leg; whatever the margin leaves over goes to traders.
    function test_safetyMarginIsReturnedToTraders() public {
        (uint256 bPerA, uint256 excessA) = _solve(100 ether, 100 ether);
        // Quote Alice 0.05% lower so the exchange leg has room to move; Bob's side is unchanged.
        uint256 margin = (bPerA * 9_995) / 10_000;
        QalibreSettlement.Interaction[] memory its = new QalibreSettlement.Interaction[](1);
        its[0] = _interaction(address(tokA), address(tokB), excessA);
        QalibreSettlement.Trade[] memory trades = _pair(100 ether, (100 ether * margin) / bPerA);
        uint256 feeBefore = tokB.balanceOf(feeRecipient);

        _settle(_prices(margin), trades, its);

        uint256 aliceGot = tokB.balanceOf(address(alice));
        uint256 feeTaken = tokB.balanceOf(feeRecipient) - feeBefore;
        assertGt(aliceGot + feeTaken, (100 ether * margin) / 1e18, "the margin came back to Alice");
        assertEq(tokB.balanceOf(address(settlement)), 0, "nothing kept");
    }

    function test_networkFeeChargedAtCostWithinSignedMax() public {
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 0);
        oa.maxNetworkFee = 0.01 ether;
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 200 ether, 0);
        QalibreSettlement.Trade[] memory trades = new QalibreSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa));
        trades[0].networkFee = 0.004 ether;
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob));
        uint256 directA = _direct(address(tokA), address(tokB), 100 ether);

        _settle(_prices(2e18), trades, _noInteractions());

        uint256 fee = ((200 ether - directA) * SURPLUS_SHARE_BPS) / 10_000;
        assertEq(tokB.balanceOf(address(alice)), 200 ether - fee - 0.004 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Things a solver (or a compromised backend) must never be able to do
    // ---------------------------------------------------------------------------------------------

    /// Audit 1.1, attack A: the solver quotes a lone seller a terrible price and routes everything to QWAP.
    /// v2 returns everything QWAP paid to the seller, so the attack only ever pays them the direct price.
    function test_underpricingALoneSellerCannotHurtThem() public {
        uint256 direct = _direct(address(tokA), address(tokB), 100 ether);
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 0);
        QalibreSettlement.Trade[] memory trades = new QalibreSettlement.Trade[](1);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa));
        QalibreSettlement.Interaction[] memory its = new QalibreSettlement.Interaction[](1);
        its[0] = _interaction(address(tokA), address(tokB), 100 ether);
        _settle(_prices(1e18), trades, its); // half the real price
        assertEq(tokB.balanceOf(address(alice)), direct, "seller still receives the full direct amount, no fee");
        assertEq(tokB.balanceOf(address(settlement)), 0);
    }

    /// Audit 1.1, attack B: a compromised backend signs the victim's order with no minimum and settles it against
    /// its own account at a bargain price. Under v1 this succeeded whenever the reference was omitted.
    function test_revert_attackerCounterpartyCannotBuyBelowDirect() public {
        QalibreSettlement.Trade[] memory trades = _pair(100 ether, 100 ether);
        vm.expectPartialRevert(QalibreSettlement.NotBetterThanDirect.selector);
        _settle(_prices(1e18), trades, _noInteractions()); // Bob would get A at half price
    }

    function test_revert_sessionOrderWithoutReferencePriceIsRejected() public {
        // tokC has no pool, so there is no reference price. A session key may not trade it.
        QalibreAccount.SessionSetup memory s = _defaultSession();
        s.anyBuyToken = true;
        vm.prank(vm.addr(ALICE));
        alice.setSession(s);
        OrderLib.Order memory o = _order(alice, address(tokA), address(tokC), 1 ether, 0);
        address[] memory toks = _sorted(address(tokA), address(tokC));
        QalibreSettlement.Trade[] memory trades = new QalibreSettlement.Trade[](1);
        trades[0].order = o;
        trades[0].signature = _sign(SESSION_PK, 1, o);
        trades[0].sellTokenIndex = toks[0] == address(tokA) ? 0 : 1;
        trades[0].buyTokenIndex = toks[0] == address(tokA) ? 1 : 0;
        uint256[] memory p = new uint256[](2);
        p[0] = 1e18;
        p[1] = 1e18;
        vm.prank(solver);
        vm.expectPartialRevert(QalibreSettlement.NoReferencePrice.selector);
        settlement.settle(toks, p, trades, _noInteractions());
    }

    function test_revert_networkFeeAboveSignedMax() public {
        QalibreSettlement.Trade[] memory trades = _pair(100 ether, 200 ether);
        trades[0].networkFee = 1; // order signed maxNetworkFee = 0
        vm.expectPartialRevert(QalibreSettlement.NetworkFeeTooHigh.selector);
        _settle(_prices(2e18), trades, _noInteractions());
    }

    function test_revert_networkFeeAboveHardCap() public {
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 0);
        oa.maxNetworkFee = type(uint256).max; // a compromised session key signs anything
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 200 ether, 0);
        QalibreSettlement.Trade[] memory trades = new QalibreSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa));
        trades[0].networkFee = 2 ether; // 1% of 200 B, above the 0.5% hard cap
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob));
        vm.expectPartialRevert(QalibreSettlement.NetworkFeeTooHigh.selector);
        _settle(_prices(2e18), trades, _noInteractions());
    }

    function test_revert_limitPriceViolated() public {
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 200 ether);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 200 ether, 0);
        QalibreSettlement.Trade[] memory trades = new QalibreSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa));
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob));
        vm.expectPartialRevert(QalibreSettlement.LimitPriceViolated.selector);
        _settle(_prices(2e18), trades, _noInteractions()); // 200 minus a fee is below 200
    }

    function test_revert_orderCannotBeFilledTwice() public {
        QalibreSettlement.Trade[] memory trades = _pair(100 ether, 200 ether);
        _settle(_prices(2e18), trades, _noInteractions());
        vm.expectRevert(QalibreSettlement.OrderFilled.selector);
        _settle(_prices(2e18), trades, _noInteractions());
    }

    function test_revert_cannotKeepUnsoldTokens() public {
        // Alice sells A that nobody buys and the solver does not swap it: the batch must revert.
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 10 ether, 0);
        QalibreSettlement.Trade[] memory trades = new QalibreSettlement.Trade[](1);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa));
        vm.expectPartialRevert(QalibreSettlement.InsufficientProceeds.selector);
        _settle(_prices(1.9e18), trades, _noInteractions());
    }

    function test_revert_onlySolver() public {
        (address[] memory toks,) = _tokens();
        vm.expectRevert(QalibreSettlement.NotSolver.selector);
        settlement.settle(toks, _prices(2e18), new QalibreSettlement.Trade[](0), _noInteractions());
    }

    function test_revert_expiredOrder() public {
        QalibreSettlement.Trade[] memory trades = _pair(100 ether, 200 ether);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(QalibreSettlement.OrderExpired.selector);
        _settle(_prices(2e18), trades, _noInteractions());
    }

    // ---------------------------------------------------------------------------------------------
    // Governance: additions are delayed and announced, removals are immediate
    // ---------------------------------------------------------------------------------------------

    function test_bootstrapOnlyOnce() public {
        vm.expectRevert(QalibreSettlement.AlreadyBootstrapped.selector);
        settlement.bootstrap(new address[](0), new address[](0), IVenueAdapter(address(adapter)));
    }

    function test_addingASolverTakesTwoDays() public {
        address evil = makeAddr("evil");
        settlement.scheduleSolver(evil);
        vm.expectPartialRevert(QalibreSettlement.NotReady.selector);
        settlement.executeSolver(evil);
        vm.warp(block.timestamp + 2 days);
        settlement.executeSolver(evil);
        assertTrue(settlement.isSolver(evil));
    }

    function test_removingASolverIsImmediate() public {
        settlement.removeSolver(solver);
        assertFalse(settlement.isSolver(solver));
    }

    function test_raisingFeesIsDelayedLoweringIsNot() public {
        settlement.setFees(10, 1_000); // lower: immediate
        assertEq(settlement.feeBps(), 10);
        settlement.setFees(50, 2_500); // higher: scheduled
        assertEq(settlement.feeBps(), 10);
        vm.expectPartialRevert(QalibreSettlement.NotReady.selector);
        settlement.executeFees();
        vm.warp(block.timestamp + 2 days);
        settlement.executeFees();
        assertEq(settlement.feeBps(), 50);
    }

    function test_feeCapsAreHardLimits() public {
        vm.expectRevert(QalibreSettlement.FeeTooHigh.selector);
        settlement.setFees(51, 0);
        vm.expectRevert(QalibreSettlement.FeeTooHigh.selector);
        settlement.setFees(0, 5_001);
        vm.expectRevert(QalibreSettlement.FeeTooHigh.selector);
        new QalibreSettlement(address(this), feeRecipient, 51, 0);
    }

    function test_onlyOwnerGoverns() public {
        address rando = makeAddr("rando");
        vm.startPrank(rando);
        vm.expectPartialRevert(Ownable.OwnableUnauthorizedAccount.selector);
        settlement.scheduleSolver(rando);
        vm.expectPartialRevert(Ownable.OwnableUnauthorizedAccount.selector);
        settlement.scheduleAdapter(rando);
        vm.expectPartialRevert(Ownable.OwnableUnauthorizedAccount.selector);
        settlement.setFees(0, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------
    // Fuzz: whatever the price, a filled order is never below direct or its minimum, and fees stay capped
    // ---------------------------------------------------------------------------------------------

    function testFuzz_neverBelowDirectOrMinimum(uint256 sellA, uint256 bPerA, uint256 minBuy) public {
        sellA = bound(sellA, 1e12, 500 ether);
        bPerA = bound(bPerA, 1e17, 4e18);
        uint256 sellB = (sellA * bPerA) / 1e18;
        vm.assume(sellB > 1e9 && sellB <= 1_000 ether);
        uint256 direct = _direct(address(tokA), address(tokB), sellA);
        minBuy = bound(minBuy, 0, sellB);

        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), sellA, minBuy);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), sellB, 0);
        QalibreSettlement.Trade[] memory trades = new QalibreSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa));
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob));
        (address[] memory toks,) = _tokens();
        vm.prank(solver);
        try settlement.settle(toks, _prices(bPerA), trades, _noInteractions()) {
            uint256 got = tokB.balanceOf(address(alice));
            assertGe(got, minBuy, "at least the signed minimum");
            // Before Qalibre's fee the trader is at or above direct; the fee comes only from the improvement.
            assertGe(got, direct, "never below a direct swap");
        } catch (bytes memory reason) {
            bytes4 sel = bytes4(reason);
            assertTrue(
                sel == QalibreSettlement.LimitPriceViolated.selector || sel == QalibreSettlement.NotBetterThanDirect.selector
                    || sel == QalibreSettlement.ExcessLeftover.selector,
                "unexpected revert"
            );
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Test-side solver: the uniform price for "sell `a` A" vs "sell `b` B", with the rest on the pool
    // ---------------------------------------------------------------------------------------------

    function _solve(uint256 a, uint256 b) internal view returns (uint256 bPerA, uint256 excessA) {
        (uint256 rA, uint256 rB) = router.reserves(address(tokA), address(tokB));
        uint256 lo = (b * 1e18 + a - 1) / a;
        uint256 hi = 1e20;
        for (uint256 i; i < 200 && lo + 1 < hi; ++i) {
            uint256 mid = (lo + hi) / 2;
            uint256 x = a - (b * 1e18) / mid;
            if ((a * mid) / 1e18 <= b + router.getAmountOut(x, rA, rB)) lo = mid;
            else hi = mid;
        }
        bPerA = lo;
        excessA = a - (b * 1e18) / bPerA;
    }

    function _sorted(address x, address y) internal pure returns (address[] memory t) {
        t = new address[](2);
        (t[0], t[1]) = x < y ? (x, y) : (y, x);
    }
}
