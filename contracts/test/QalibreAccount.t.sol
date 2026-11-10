// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./utils/Base.t.sol";
import {MockValidator, MockERC20} from "./utils/Mocks.sol";
import {QalibreAccount} from "../src/QalibreAccount.sol";
import {QalibreAccountFactory} from "../src/QalibreAccountFactory.sol";
import {QalibreSettlement} from "../src/QalibreSettlement.sol";
import {QalibrePaymaster} from "../src/QalibrePaymaster.sol";
import {OrderLib} from "../src/libraries/OrderLib.sol";
import {ISignatureValidator} from "../src/interfaces/ISignatureValidator.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract QalibreAccountTest is BaseTest {
    uint256 internal constant ALICE = 0xA11CE;
    uint256 internal constant BOB = 0xB0B;
    address internal aliceOwner;

    QalibreAccount internal alice;
    QalibreAccount internal bob;

    function setUp() public override {
        super.setUp();
        aliceOwner = vm.addr(ALICE);
        alice = _createFunded(ALICE, 2_000 ether, 0);
        bob = _createFunded(BOB, 0, 100_000 ether);
        // Bob trades with a wide session so only Alice's limits are under test.
        QalibreAccount.SessionSetup memory wide = _defaultSession();
        wide.limits[1] = QalibreAccount.TokenLimit(address(tokB), 100_000 ether, 100_000 ether);
        vm.prank(vm.addr(BOB));
        bob.setSession(wide);
    }

    /// Alice (session key) sells `amountA` A to Bob at 2 B/A.
    function _sessionTrade(uint256 amountA) internal {
        _settle(_prices(2e18), _sessionTrades(amountA), _noInteractions());
    }

    /// Same, but asserts the batch reverts with `selector`. Orders are signed before arming expectRevert.
    function _sessionTradeReverts(uint256 amountA, bytes4 selector) internal {
        QalibreSettlement.Trade[] memory trades = _sessionTrades(amountA);
        uint256[] memory prices = _prices(2e18);
        vm.expectRevert(selector);
        _settle(prices, trades, _noInteractions());
    }

    function _sessionTrades(uint256 amountA) internal view returns (QalibreSettlement.Trade[] memory trades) {
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), amountA, 0);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), amountA * 2, 0);
        trades = new QalibreSettlement.Trade[](2);
        trades[0] = _trade(oa, _sign(SESSION_PK, 1, oa));
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob));
    }

    // ---------------------------------------------------------------------------------------------
    // Factory
    // ---------------------------------------------------------------------------------------------

    function test_factoryPredictsAddressAndIsIdempotent() public {
        assertEq(address(alice), factory.getAddress(aliceOwner, 0));
        assertEq(alice.owner(), aliceOwner);
        assertEq(alice.settlement(), address(settlement));
        assertEq(alice.sessionKey(), sessionKey);
        // Calling again returns the same account and does not re-initialize it.
        QalibreAccount again = _createAccount(ALICE, _defaultSession());
        assertEq(address(again), address(alice));
    }

    function test_revert_factoryRejectsSetupNotSignedByOwner() public {
        QalibreAccountFactory.Setup memory s =
            QalibreAccountFactory.Setup({owner: vm.addr(0xCAFE), salt: 0, session: _defaultSession()});
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(factory.setupHash(s));
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(SESSION_PK, h); // attacker signs instead of the owner
        vm.expectRevert(QalibreAccountFactory.BadOwnerSignature.selector);
        factory.createAccount(s, abi.encodePacked(r, sg, v));
    }

    function test_revert_cannotReinitialize() public {
        vm.expectRevert();
        alice.initialize(makeAddr("attacker"), address(settlement), _defaultSession());
    }

    // ---------------------------------------------------------------------------------------------
    // Session key: what it CAN do
    // ---------------------------------------------------------------------------------------------

    function test_sessionKeyTradesWithinLimits() public {
        _sessionTrade(500 ether);
        assertEq(tokA.balanceOf(address(alice)), 1_500 ether);
        uint256 direct = _direct(address(tokA), address(tokB), 500 ether);
        uint256 capFee = (1000 ether * FEE_BPS) / 10_000;
        uint256 savingsFee = ((1000 ether - direct) * SURPLUS_SHARE_BPS) / 10_000;
        assertEq(tokB.balanceOf(address(alice)), 1000 ether - (capFee < savingsFee ? capFee : savingsFee));
        assertEq(alice.spentToday(address(tokA)), 500 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Session key: what it can NEVER do
    // ---------------------------------------------------------------------------------------------

    function test_revert_sessionKeyCannotExecute() public {
        vm.prank(sessionKey);
        vm.expectRevert(QalibreAccount.NotAuthorized.selector);
        alice.execute(address(tokA), 0, abi.encodeCall(IERC20.transfer, (sessionKey, 1 ether)));
    }

    function test_revert_sessionKeyCannotWithdraw() public {
        vm.prank(sessionKey);
        vm.expectRevert(QalibreAccount.NotAuthorized.selector);
        alice.withdrawToOwner(address(tokA), 1 ether);
    }

    function test_revert_sessionKeyCannotChangeSettings() public {
        vm.startPrank(sessionKey);
        vm.expectRevert(QalibreAccount.NotAuthorized.selector);
        alice.setTokenLimit(address(tokA), 1e30, 1e30);
        vm.expectRevert(QalibreAccount.NotAuthorized.selector);
        alice.setSettlement(sessionKey);
        vm.expectRevert(QalibreAccount.NotAuthorized.selector);
        alice.setValidator(ISignatureValidator(sessionKey));
        vm.expectRevert(QalibreAccount.NotAuthorized.selector);
        alice.setOwner(sessionKey);
        vm.stopPrank();
    }

    function test_sessionKeyCannotSignUserOperations() public {
        PackedUserOperation memory op = _userOp(alice, abi.encodeCall(QalibreAccount.withdrawToOwner, (address(tokA), 1)));
        op.signature = _signUserOp(SESSION_PK, op);
        bytes32 opHash = entryPoint.getUserOpHash(op);
        vm.prank(address(entryPoint));
        uint256 validation = alice.validateUserOp(op, opHash, 0);
        assertEq(validation, 1, "SIG_VALIDATION_FAILED");
    }

    function test_sessionKeyIsNotAcceptedForERC1271() public view {
        bytes32 h = keccak256("anything");
        bytes32 safe = alice.replaySafeHash(h);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_PK, safe);
        assertEq(alice.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
        (v, r, s) = vm.sign(ALICE, safe);
        assertEq(alice.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
    }

    /// Audit 1.7: a signature for one account cannot be replayed against another account of the same owner.
    function test_erc1271SignatureIsBoundToTheAccount() public {
        QalibreAccountFactory.Setup memory s2 = QalibreAccountFactory.Setup({owner: aliceOwner, salt: 1, session: _defaultSession()});
        (uint8 v0, bytes32 r0, bytes32 sg0) = vm.sign(ALICE, MessageHashUtils.toEthSignedMessageHash(factory.setupHash(s2)));
        QalibreAccount second = factory.createAccount(s2, abi.encodePacked(r0, sg0, v0));
        bytes32 h = keccak256("pay me");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE, alice.replaySafeHash(h));
        assertEq(alice.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0x1626ba7e));
        assertEq(second.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
    }

    /// Audit 3.2: native QMS from the faucet is wrapped automatically when an order needs it.
    function test_nativeQmsIsWrappedAutomatically() public {
        QalibreAccount carol = _createAccount(0xCA401, _defaultSession());
        vm.deal(address(carol), 3 ether); // faucet-style native balance, no WQMS
        tokB.mint(address(bob), 0);
        OrderLib.Order memory oc = _order(carol, address(tokA), address(tokB), 2 ether, 0);
        OrderLib.Order memory ob = _order(bob, address(tokB), address(tokA), 4 ether, 0);
        QalibreSettlement.Trade[] memory trades = new QalibreSettlement.Trade[](2);
        trades[0] = _trade(oc, _sign(SESSION_PK, 1, oc));
        trades[1] = _trade(ob, _sign(SESSION_PK, 1, ob));
        _settle(_prices(2e18), trades, _noInteractions());
        assertEq(address(carol).balance, 1 ether, "only the shortfall was wrapped");
        assertGt(tokB.balanceOf(address(carol)), 0);
    }

    function test_revert_onlySettlementCanPullFunds() public {
        OrderLib.Order memory oa = _order(alice, address(tokA), address(tokB), 100 ether, 0);
        bytes memory sig = _sign(SESSION_PK, 1, oa);
        vm.prank(sessionKey);
        vm.expectRevert(QalibreAccount.NotSettlement.selector);
        alice.authorizeOrder(oa, sig);
    }

    function test_revert_perTradeLimit() public {
        _sessionTradeReverts(1_001 ether, QalibreAccount.PerTradeLimit.selector);
    }

    function test_perDayLimitResetsNextDay() public {
        _sessionTrade(1_000 ether);
        _sessionTrade(1_000 ether - 1); // reach just under the 2000/day cap
        tokA.mint(address(alice), 10 ether);
        _sessionTradeReverts(2 ether, QalibreAccount.PerDayLimit.selector);
        vm.warp(block.timestamp + 1 days);
        _sessionTrade(2 ether);
    }

    function test_revert_sellTokenNotAllowed() public {
        router.addPool(address(tokC), address(tokB), 1_000 ether, 1_000 ether);
        tokC.mint(address(alice), 10 ether);
        OrderLib.Order memory oc = _order(alice, address(tokC), address(tokB), 1 ether, 0);
        QalibreSettlement.Trade[] memory trades = new QalibreSettlement.Trade[](1);
        address[] memory toks = _sorted3();
        trades[0].order = oc;
        trades[0].signature = _sign(SESSION_PK, 1, oc);
        trades[0].sellTokenIndex = _idx(toks, address(tokC));
        trades[0].buyTokenIndex = _idx(toks, address(tokB));
        uint256[] memory p = new uint256[](3);
        p[0] = 1e18;
        p[1] = 1e18;
        p[2] = 1e18;
        vm.prank(solver);
        vm.expectRevert(QalibreAccount.SellTokenNotAllowed.selector);
        settlement.settle(toks, p, trades, _noInteractions());
    }

    function test_revert_buyTokenNotAllowed() public {
        vm.prank(aliceOwner);
        alice.setBuyTokenAllowed(address(tokB), false);
        _sessionTradeReverts(1 ether, QalibreAccount.BuyTokenNotAllowed.selector);
    }

    function test_revert_expiredSession() public {
        vm.warp(block.timestamp + 31 days);
        // Orders are created after the warp, so only the session expiry can fail them.
        _sessionTradeReverts(1 ether, QalibreAccount.SessionInactive.selector);
    }

    function test_revert_revokedSessionStopsImmediately() public {
        vm.prank(aliceOwner);
        alice.revokeSession();
        assertFalse(alice.sessionActive());
        _sessionTradeReverts(1 ether, QalibreAccount.SessionInactive.selector);
    }

    function test_newSessionDoesNotInheritOldLimits() public {
        vm.startPrank(aliceOwner);
        alice.revokeSession();
        QalibreAccount.SessionSetup memory s = _defaultSession();
        s.limits = new QalibreAccount.TokenLimit[](0); // nothing allowed this time
        alice.setSession(s);
        vm.stopPrank();
        _sessionTradeReverts(1 ether, QalibreAccount.SellTokenNotAllowed.selector);
    }

    // ---------------------------------------------------------------------------------------------
    // Owner
    // ---------------------------------------------------------------------------------------------

    function test_ownerWithdrawsDirectlyWithoutQalibre() public {
        vm.prank(aliceOwner);
        alice.withdrawToOwner(address(tokA), 2_000 ether);
        assertEq(tokA.balanceOf(aliceOwner), 2_000 ether);

        vm.deal(address(alice), 1 ether);
        vm.prank(aliceOwner);
        alice.withdrawToOwner(address(0), 1 ether);
        assertEq(aliceOwner.balance, 1 ether);
    }

    function test_ownerUserOperationThroughEntryPoint() public {
        vm.deal(address(alice), 1 ether); // pays its own gas in this test
        PackedUserOperation memory op =
            _userOp(alice, abi.encodeCall(QalibreAccount.withdrawToOwner, (address(tokA), 123 ether)));
        op.signature = _signUserOp(ALICE, op);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, payable(makeAddr("bundler")));
        assertEq(tokA.balanceOf(aliceOwner), 123 ether);
    }

    function test_gaslessUserOperationViaPaymaster() public {
        uint256 sponsorPk = 0x5905;
        QalibrePaymaster pm = new QalibrePaymaster(IEntryPoint(address(entryPoint)), vm.addr(sponsorPk), address(this));
        assertEq(pm.owner(), address(this), "paymaster owner is explicit");
        pm.deposit{value: 1 ether}();
        assertEq(address(alice).balance, 0); // the user has no gas money at all

        PackedUserOperation memory op = _userOp(alice, abi.encodeCall(QalibreAccount.revokeSession, ()));
        uint48 validUntil = uint48(block.timestamp + 10 minutes);
        // paymasterAndData = paymaster | verificationGas | postOpGas | (validUntil, validAfter) | signature
        op.paymasterAndData =
            abi.encodePacked(address(pm), uint128(100_000), uint128(0), abi.encode(validUntil, uint48(0)));
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(pm.getHash(op, validUntil, 0));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(sponsorPk, h);
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, r, s, v);
        op.signature = _signUserOp(ALICE, op);

        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        entryPoint.handleOps(ops, payable(makeAddr("bundler")));
        assertFalse(alice.sessionActive());
    }

    function test_postQuantumSlot_ownerCanSwapValidator() public {
        bytes32 secret = keccak256("pq-key");
        MockValidator pq = new MockValidator(secret);
        vm.prank(aliceOwner);
        alice.setValidator(pq);

        // ECDSA owner signatures stop working for ERC-1271; the new scheme works.
        bytes32 h = keccak256("msg");
        bytes32 safe = alice.replaySafeHash(h);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ALICE, safe);
        assertEq(alice.isValidSignature(h, abi.encodePacked(r, s, v)), bytes4(0xffffffff));
        assertEq(alice.isValidSignature(h, abi.encode(keccak256(abi.encode(secret, safe)))), bytes4(0x1626ba7e));

        // With a validator installed, the ECDSA owner address may be cleared entirely.
        vm.prank(aliceOwner);
        alice.setOwner(address(0));
        assertEq(alice.owner(), address(0));
    }

    function test_paymasterOwnerIsExplicitEvenViaFactory() public {
        // Deploying through another contract (like a CREATE2 factory) must not make that contract the owner.
        address intended = makeAddr("intended");
        Deployer d = new Deployer();
        QalibrePaymaster pm = d.deploy(IEntryPoint(address(entryPoint)), intended);
        assertEq(pm.owner(), intended);
    }

    function test_revert_cannotClearOwnerWithoutValidator() public {
        vm.prank(aliceOwner);
        vm.expectRevert(QalibreAccount.ZeroAddress.selector);
        alice.setOwner(address(0));
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _userOp(QalibreAccount acct, bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = address(acct);
        op.nonce = entryPoint.getNonce(address(acct), 0);
        op.callData = callData;
        op.accountGasLimits = bytes32((uint256(200_000) << 128) | uint256(200_000));
        op.preVerificationGas = 50_000;
        op.gasFees = bytes32((uint256(1 gwei) << 128) | uint256(2 gwei));
    }

    function _signUserOp(uint256 pk, PackedUserOperation memory op) internal view returns (bytes memory) {
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(entryPoint.getUserOpHash(op));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, h);
        return abi.encodePacked(r, s, v);
    }

    function _sorted3() internal view returns (address[] memory t) {
        t = new address[](3);
        t[0] = address(tokA);
        t[1] = address(tokB);
        t[2] = address(tokC);
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (t[j] < t[i]) (t[i], t[j]) = (t[j], t[i]);
            }
        }
    }
}

contract Deployer {
    function deploy(IEntryPoint ep, address owner_) external returns (QalibrePaymaster) {
        return new QalibrePaymaster(ep, owner_, owner_);
    }
}
