// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "./utils/Base.t.sol";
import {MockERC20} from "./utils/Mocks.sol";
import {QalibreAccount} from "../src/QalibreAccount.sol";
import {QalibreSettlement} from "../src/QalibreSettlement.sol";
import {OrderLib} from "../src/libraries/OrderLib.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev The attacker holds BOTH the session key and the solver role (i.e. a fully compromised Qalibre backend)
///      and throws random actions at a victim's account.
interface IVenueAdapterLike {
    function quote(address, address, uint256, bytes calldata) external view returns (uint256);
}

contract CompromisedBackend is Test {
    QalibreAccount public immutable victim;
    QalibreAccount public immutable counterparty;
    QalibreSettlement public immutable settlement;
    MockERC20 public immutable tokA;
    MockERC20 public immutable tokB;
    uint256 public immutable sessionPk;
    address public immutable attacker;
    address public immutable adapter;

    uint256 public victimSoldToday;
    /// Set if the victim ever received less than a direct swap would have paid (audit 1.1).
    bool public victimShortchanged;
    uint256 public settledCount;
    uint256 public lastDay;
    uint256 public nonce;

    constructor(
        QalibreAccount v,
        QalibreAccount c,
        QalibreSettlement s,
        MockERC20 a,
        MockERC20 b,
        uint256 pk,
        address adapter_
    ) {
        victim = v;
        counterparty = c;
        settlement = s;
        tokA = a;
        tokB = b;
        sessionPk = pk;
        attacker = vm.addr(pk);
        adapter = adapter_;
        lastDay = block.timestamp / 1 days;
    }

    function tryDirectTheft(uint256 amount) external {
        vm.startPrank(attacker);
        try victim.execute(address(tokA), 0, abi.encodeCall(IERC20.transfer, (attacker, amount))) {} catch {}
        try victim.withdrawToOwner(address(tokA), amount) {} catch {}
        try victim.setOwner(attacker) {} catch {}
        try victim.setSettlement(attacker) {} catch {}
        vm.stopPrank();
    }

    /// Victim sells A at whatever price the attacker picks; the attacker-controlled counterparty buys.
    function sellAtAttackerPrice(uint256 amount, uint256 bPerA) external {
        amount = bound(amount, 1, 1_500 ether);
        bPerA = bound(bPerA, 1, 10e18);
        uint256 bAmount = (amount * bPerA) / 1e18;
        if (bAmount == 0) return;
        tokB.mint(address(counterparty), bAmount);

        OrderLib.Order memory ov = _order(victim, address(tokA), address(tokB), amount, 0);
        OrderLib.Order memory oc = _order(counterparty, address(tokB), address(tokA), bAmount, 0);
        QalibreSettlement.Trade[] memory trades = new QalibreSettlement.Trade[](2);
        trades[0] = _t(ov);
        trades[1] = _t(oc);
        uint256[] memory prices = new uint256[](2);
        (address[] memory toks, bool aFirst) = _tokens();
        (prices[0], prices[1]) = aFirst ? (bPerA, uint256(1e18)) : (uint256(1e18), bPerA);

        uint256 day = block.timestamp / 1 days;
        if (day != lastDay) {
            lastDay = day;
            victimSoldToday = 0;
        }
        uint256 before = tokA.balanceOf(address(victim));
        uint256 beforeB = tokB.balanceOf(address(victim));
        uint256 direct = IVenueAdapterLike(adapter).quote(address(tokA), address(tokB), amount, "");
        vm.prank(attacker);
        try settlement.settle(toks, prices, trades, new QalibreSettlement.Interaction[](0)) {
            victimSoldToday += before - tokA.balanceOf(address(victim));
            if (tokB.balanceOf(address(victim)) - beforeB < direct) victimShortchanged = true;
            settledCount++;
        } catch {}
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }

    function _order(QalibreAccount a, address sell, address buy, uint256 amt, uint256 minBuy)
        internal
        returns (OrderLib.Order memory)
    {
        return OrderLib.Order(address(a), sell, buy, amt, minBuy, 0, uint64(block.timestamp + 1 hours), ++nonce);
    }

    function _t(OrderLib.Order memory o) internal view returns (QalibreSettlement.Trade memory t) {
        (address[] memory toks,) = _tokens();
        bytes32 digest = settlement.orderDigest(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sessionPk, digest);
        t.order = o;
        t.signature = abi.encodePacked(uint8(1), r, s, v);
        t.sellTokenIndex = toks[0] == o.sellToken ? 0 : 1;
        t.buyTokenIndex = toks[0] == o.buyToken ? 0 : 1;
    }

    function _tokens() internal view returns (address[] memory toks, bool aFirst) {
        toks = new address[](2);
        aFirst = address(tokA) < address(tokB);
        (toks[0], toks[1]) = aFirst ? (address(tokA), address(tokB)) : (address(tokB), address(tokA));
    }
}

contract InvariantsTest is BaseTest {
    CompromisedBackend internal handler;
    QalibreAccount internal victim;
    address internal victimOwner;

    function setUp() public override {
        super.setUp();
        victim = _createFunded(0xA11CE, 1_000_000 ether, 0);
        victimOwner = vm.addr(0xA11CE);
        QalibreAccount counterparty = _createAccount(0xB0B, _wideSession());
        // Worst case: the attacker is also a whitelisted solver.
        settlement.scheduleSolver(sessionKey);
        vm.warp(block.timestamp + 2 days);
        settlement.executeSolver(sessionKey);
        handler = new CompromisedBackend(victim, counterparty, settlement, tokA, tokB, SESSION_PK, address(adapter));
        targetContract(address(handler));
    }

    function _wideSession() internal view returns (QalibreAccount.SessionSetup memory s) {
        s = _defaultSession();
        s.limits[1] = QalibreAccount.TokenLimit(address(tokB), type(uint128).max, type(uint128).max);
    }

    /// The attacker never ends up holding any of the victim's tokens.
    function invariant_attackerGetsNothing() public view {
        assertEq(tokA.balanceOf(sessionKey), 0);
        assertEq(tokB.balanceOf(sessionKey), 0);
    }

    /// Audit 1.1: even with the session key AND the solver role, and its own account as the counterparty,
    /// the attacker can never settle the victim below what a direct swap would pay.
    function invariant_victimNeverBelowDirect() public view {
        assertFalse(handler.victimShortchanged());
    }

    /// Ownership and the trusted settlement contract never change.
    function invariant_controlNeverChanges() public view {
        assertEq(victim.owner(), victimOwner);
        assertEq(victim.settlement(), address(settlement));
    }

    /// Whatever the attacker does, the victim never sells more than its daily cap (2000 A).
    function invariant_dailyCapHolds() public view {
        assertLe(handler.victimSoldToday(), 2_000 ether);
    }

    /// Guard against a vacuous invariant: the attacker's handler really can settle trades (at fair prices),
    /// so "victim never below direct" is tested against batches that actually executed.
    function test_handlerCanActuallySettle() public {
        handler.sellAtAttackerPrice(10 ether, 2e18); // a fair price: must settle
        assertEq(handler.settledCount(), 1, "handler settled a real batch");
        handler.sellAtAttackerPrice(10 ether, 1e18); // a bargain for the attacker: must be refused
        assertEq(handler.settledCount(), 1, "bad-price batch was refused");
        assertFalse(handler.victimShortchanged());
    }

    /// The settlement contract never accumulates funds.
    function invariant_settlementHoldsNothing() public view {
        assertEq(tokA.balanceOf(address(settlement)), 0);
        assertEq(tokB.balanceOf(address(settlement)), 0);
    }
}
