// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafetyProbe} from "../../src/periphery/SafetyProbe.sol";
import {QalibreTestMintable, QalibreTestHoneypot, QalibreTestTaxed} from "../../src/testnet/QalibreTestTokens.sol";

interface IRouterAdd {
    function factory() external view returns (address);
    function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256)
        external
        returns (uint256, uint256, uint256);
}

interface IFactory {
    function getPair(address, address) external view returns (address);
}

interface IWQMS {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
}

/// Runs the safety probe against the real QWAP router on a fork of QMS testnet.
contract SafetyProbeForkTest is Test {
    address constant ROUTER = 0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619;
    address constant WQMS = 0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34;
    bool enabled;
    SafetyProbe probe;

    function setUp() public {
        string memory rpc = vm.envOr("QMS_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        enabled = true;
        probe = new SafetyProbe();
        vm.deal(address(this), 100 ether);
        IWQMS(WQMS).deposit{value: 30 ether}();
        IWQMS(WQMS).approve(ROUTER, type(uint256).max);
    }

    modifier onlyFork() {
        if (!enabled) {
            vm.skip(true);
            return;
        }
        _;
    }

    function _pool(address token) internal {
        IERC20(token).approve(ROUTER, type(uint256).max);
        IRouterAdd(ROUTER).addLiquidity(token, WQMS, 1_000_000 ether, 10 ether, 0, 0, address(this), block.timestamp);
    }

    function test_fork_cleanTokenPasses() public onlyFork {
        QalibreTestMintable t = new QalibreTestMintable(10_000_000 ether);
        _pool(address(t));
        SafetyProbe.Result memory r = probe.probe{value: 0.01 ether}(ROUTER, WQMS, address(t));
        assertTrue(r.buyOk && r.sellOk, "can buy and sell");
        assertEq(r.bought, r.expectedBuy, "no buy tax");
        assertEq(r.soldFor, r.expectedSell, "no sell tax");
    }

    function test_fork_honeypotIsCaught() public onlyFork {
        QalibreTestHoneypot t = new QalibreTestHoneypot(10_000_000 ether);
        _pool(address(t));
        t.setPool(IFactory(IRouterAdd(ROUTER).factory()).getPair(address(t), WQMS));
        SafetyProbe.Result memory r = probe.probe{value: 0.01 ether}(ROUTER, WQMS, address(t));
        assertTrue(r.buyOk, "buying works (that is the trap)");
        assertFalse(r.sellOk, "selling is blocked: honeypot detected");
    }

    function test_fork_taxIsMeasured() public onlyFork {
        QalibreTestTaxed t = new QalibreTestTaxed(10_000_000 ether);
        _pool(address(t));
        SafetyProbe.Result memory r = probe.probe{value: 0.01 ether}(ROUTER, WQMS, address(t));
        assertTrue(r.buyOk && r.sellOk);
        uint256 buyTaxBps = 10_000 - (r.bought * 10_000) / r.expectedBuy;
        assertApproxEqAbs(buyTaxBps, 1_000, 5, "about 10% buy tax measured");
        assertLt(r.soldFor, r.expectedSell, "sell tax measured");
    }
}
