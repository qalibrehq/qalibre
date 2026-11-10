// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EntryPoint} from "account-abstraction/core/EntryPoint.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import {QalibreAccount} from "../../src/QalibreAccount.sol";
import {QalibreAccountFactory} from "../../src/QalibreAccountFactory.sol";
import {QalibreSettlement} from "../../src/QalibreSettlement.sol";
import {QwapV2Adapter, IQwapRouter} from "../../src/adapters/QwapV2Adapter.sol";
import {OrderLib} from "../../src/libraries/OrderLib.sol";
import {MockERC20, MockV2Router} from "./Mocks.sol";

abstract contract BaseTest is Test {
    EntryPoint internal entryPoint;
    QalibreSettlement internal settlement;
    QalibreAccountFactory internal factory;
    MockV2Router internal router;
    QwapV2Adapter internal adapter;
    MockERC20 internal tokA;
    MockERC20 internal tokB;
    MockERC20 internal tokC;

    address internal feeRecipient = makeAddr("feeRecipient");
    address internal solver = makeAddr("solver");

    uint256 internal constant SESSION_PK = 0xBEEF; // the backend's session key
    address internal sessionKey;

    uint256 internal constant FEE_BPS = 50; // 0.5% (the hard cap)
    uint256 internal constant SURPLUS_SHARE_BPS = 2_500; // 25% of savings

    function setUp() public virtual {
        sessionKey = vm.addr(SESSION_PK);
        entryPoint = new EntryPoint();
        settlement = new QalibreSettlement(address(this), feeRecipient, FEE_BPS, SURPLUS_SHARE_BPS);
        factory = new QalibreAccountFactory(IEntryPoint(address(entryPoint)), address(settlement));
        router = new MockV2Router();
        adapter = new QwapV2Adapter(IQwapRouter(address(router)), address(settlement));
        settlement.setSolver(solver, true);
        settlement.setAdapter(address(adapter), true);

        tokA = new MockERC20("Token A", "A", 18);
        tokB = new MockERC20("Token B", "B", 18);
        tokC = new MockERC20("Token C", "C", 18);
        // Pool price: 1 A = 2 B.
        router.addPool(address(tokA), address(tokB), 10_000 ether, 20_000 ether);
    }

    // ---------------------------------------------------------------------------------------------
    // Accounts
    // ---------------------------------------------------------------------------------------------

    function _defaultSession() internal view returns (QalibreAccount.SessionSetup memory s) {
        s.key = sessionKey;
        s.validUntil = uint48(block.timestamp + 30 days);
        s.anyBuyToken = false;
        s.limits = new QalibreAccount.TokenLimit[](2);
        s.limits[0] = QalibreAccount.TokenLimit(address(tokA), 1_000 ether, 2_000 ether);
        s.limits[1] = QalibreAccount.TokenLimit(address(tokB), 1_000 ether, 2_000 ether);
        s.buyTokens = new address[](2);
        s.buyTokens[0] = address(tokA);
        s.buyTokens[1] = address(tokB);
    }

    function _createAccount(uint256 ownerPk, QalibreAccount.SessionSetup memory session)
        internal
        returns (QalibreAccount acct)
    {
        QalibreAccountFactory.Setup memory s =
            QalibreAccountFactory.Setup({owner: vm.addr(ownerPk), salt: 0, session: session});
        bytes32 h = MessageHashUtils.toEthSignedMessageHash(factory.setupHash(s));
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(ownerPk, h);
        acct = factory.createAccount(s, abi.encodePacked(r, sg, v));
    }

    function _createFunded(uint256 ownerPk, uint256 amountA, uint256 amountB) internal returns (QalibreAccount acct) {
        acct = _createAccount(ownerPk, _defaultSession());
        tokA.mint(address(acct), amountA);
        tokB.mint(address(acct), amountB);
    }

    // ---------------------------------------------------------------------------------------------
    // Orders
    // ---------------------------------------------------------------------------------------------

    function _order(QalibreAccount acct, address sell, address buy, uint256 sellAmount, uint256 minBuy)
        internal
        view
        returns (OrderLib.Order memory)
    {
        return OrderLib.Order({
            account: address(acct),
            sellToken: sell,
            buyToken: buy,
            sellAmount: sellAmount,
            minBuyAmount: minBuy,
            validTo: uint64(block.timestamp + 1 hours),
            nonce: uint256(keccak256(abi.encode(acct, sell, sellAmount, minBuy, block.timestamp)))
        });
    }

    function _sign(uint256 pk, uint8 kind, OrderLib.Order memory o) internal view returns (bytes memory) {
        bytes32 digest = settlement.orderDigest(o);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(kind, r, s, v);
    }

    function _trade(OrderLib.Order memory o, bytes memory sig, bool withRef)
        internal
        view
        returns (QalibreSettlement.Trade memory t)
    {
        (address[] memory toks,) = _tokens();
        t.order = o;
        t.signature = sig;
        t.sellTokenIndex = _idx(toks, o.sellToken);
        t.buyTokenIndex = _idx(toks, o.buyToken);
        t.refAdapter = withRef ? address(adapter) : address(0);
    }

    /// @dev Tokens A and B sorted ascending, as the settlement contract requires.
    function _tokens() internal view returns (address[] memory toks, bool aFirst) {
        toks = new address[](2);
        aFirst = address(tokA) < address(tokB);
        (toks[0], toks[1]) = aFirst ? (address(tokA), address(tokB)) : (address(tokB), address(tokA));
    }

    /// @dev Clearing prices so that 1 A = `bPerA` B (bPerA scaled by 1e18).
    function _prices(uint256 bPerA) internal view returns (uint256[] memory p) {
        (, bool aFirst) = _tokens();
        p = new uint256[](2);
        (p[0], p[1]) = aFirst ? (bPerA, uint256(1e18)) : (uint256(1e18), bPerA);
    }

    function _idx(address[] memory toks, address t) internal pure returns (uint256) {
        for (uint256 i; i < toks.length; ++i) {
            if (toks[i] == t) return i;
        }
        revert("token not in batch");
    }

    function _interaction(address tokenIn, address tokenOut, uint256 amountIn)
        internal
        view
        returns (QalibreSettlement.Interaction memory it)
    {
        (address[] memory toks,) = _tokens();
        it.adapter = address(adapter);
        it.tokenInIndex = _idx(toks, tokenIn);
        it.tokenOutIndex = _idx(toks, tokenOut);
        it.amountIn = amountIn;
        it.minAmountOut = 0;
    }

    function _settle(
        uint256[] memory prices,
        QalibreSettlement.Trade[] memory trades,
        QalibreSettlement.Interaction[] memory its
    ) internal {
        (address[] memory toks,) = _tokens();
        vm.prank(solver);
        settlement.settle(toks, prices, trades, its);
    }

    function _noInteractions() internal pure returns (QalibreSettlement.Interaction[] memory) {
        return new QalibreSettlement.Interaction[](0);
    }
}
