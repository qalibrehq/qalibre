// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {QalibreTestPlain} from "../src/testnet/QalibreTestTokens.sol";

interface IRouterAdd {
    function addLiquidity(address, address, uint256, uint256, uint256, uint256, address, uint256)
        external
        returns (uint256, uint256, uint256);
}

interface IWQMS {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// TESTNET ONLY: a plain fixed-supply token with a real QWAP pool holding 99% of the supply.
///   forge script script/DeployTestPlain.s.sol --rpc-url qms --broadcast --slow
contract DeployTestPlain is Script {
    address constant ROUTER = 0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619;
    address constant WQMS = 0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34;
    uint256 constant SUPPLY = 1_000_000 ether;
    uint256 constant POOL_TOKENS = 990_000 ether; // 99%: no wallet holds a dominant share
    uint256 constant POOL_WQMS = 4.5 ether; // deep enough that a 0.2 QMS buy moves the price under 5%

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);
        vm.startBroadcast(pk);
        uint256 have = IWQMS(WQMS).balanceOf(me);
        if (have < POOL_WQMS) IWQMS(WQMS).deposit{value: POOL_WQMS - have}();
        IWQMS(WQMS).approve(ROUTER, POOL_WQMS);
        QalibreTestPlain plain = new QalibreTestPlain(SUPPLY);
        IERC20(address(plain)).approve(ROUTER, POOL_TOKENS);
        IRouterAdd(ROUTER).addLiquidity(address(plain), WQMS, POOL_TOKENS, POOL_WQMS, POOL_TOKENS, POOL_WQMS, me, block.timestamp + 600);
        vm.stopBroadcast();
        vm.writeJson(vm.serializeAddress("plain", "QTPLAIN", address(plain)), string.concat(vm.projectRoot(), "/deployments/19480-testtoken-plain.json"));
        console2.log("QTPLAIN", address(plain));
    }
}
