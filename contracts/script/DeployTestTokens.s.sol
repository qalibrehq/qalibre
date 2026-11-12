// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {QalibreTestMintable, QalibreTestHoneypot, QalibreTestTaxed} from "../src/testnet/QalibreTestTokens.sol";

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
    function balanceOf(address) external view returns (uint256);
}

/// TESTNET ONLY: three labelled tokens with real QWAP pools, used to demonstrate the safety check.
///   forge script script/DeployTestTokens.s.sol --rpc-url qms --broadcast --slow
contract DeployTestTokens is Script {
    address constant ROUTER = 0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619;
    address constant WQMS = 0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34;
    uint256 constant SUPPLY = 10_000_000 ether;
    uint256 constant POOL_TOKENS = 5_000_000 ether;
    uint256 constant POOL_WQMS = 0.8 ether;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(pk);
        IWQMS(WQMS).deposit{value: 3 * POOL_WQMS}();
        IWQMS(WQMS).approve(ROUTER, type(uint256).max);

        QalibreTestMintable dog = new QalibreTestMintable(SUPPLY);
        QalibreTestHoneypot honey = new QalibreTestHoneypot(SUPPLY);
        QalibreTestTaxed tax = new QalibreTestTaxed(SUPPLY);
        address[3] memory tokens = [address(dog), address(honey), address(tax)];
        for (uint256 i; i < 3; ++i) {
            IERC20(tokens[i]).approve(ROUTER, type(uint256).max);
            IRouterAdd(ROUTER).addLiquidity(tokens[i], WQMS, POOL_TOKENS, POOL_WQMS, 0, 0, vm.addr(pk), block.timestamp + 600);
        }
        honey.setPool(IFactory(IRouterAdd(ROUTER).factory()).getPair(address(honey), WQMS));
        vm.stopBroadcast();

        string memory k = "testTokens";
        vm.serializeAddress(k, "QTDOG", address(dog));
        vm.serializeAddress(k, "QTHONEY", address(honey));
        string memory json = vm.serializeAddress(k, "QTTAX", address(tax));
        vm.writeJson(json, string.concat(vm.projectRoot(), "/deployments/19480-testtokens.json"));
        console2.log("QTDOG  ", address(dog));
        console2.log("QTHONEY", address(honey));
        console2.log("QTTAX  ", address(tax));
    }
}
