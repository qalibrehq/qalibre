// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";
import {QalibreAccountFactory} from "../src/QalibreAccountFactory.sol";

/// Wallet v3 (Fast mode). Deploys only a new account factory, and with it the new wallet implementation, pointed at
/// the existing settlement contract. Settlement, adapter and paymaster are unchanged. The v2 record is kept in
/// deployments/19480-qalibre-v2.json.
///   forge script script/DeployWalletV3.s.sol --rpc-url qms --broadcast --slow
contract DeployWalletV3 is Script {
    address constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant WQMS = 0x9AA510295aC664A3d5A3182a3eFe959DE2B12c34;
    bytes32 constant SALT = keccak256("qalibre.v3.wallet");

    function run() external {
        string memory path = string.concat(vm.projectRoot(), "/deployments/19480.json");
        address settlement = vm.parseJsonAddress(vm.readFile(path), ".settlement");
        require(settlement.code.length > 0, "settlement not deployed");
        bytes memory init = abi.encodePacked(type(QalibreAccountFactory).creationCode, abi.encode(IEntryPoint(ENTRY_POINT), settlement, WQMS));
        address predicted = vm.computeCreate2Address(SALT, keccak256(init));

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        if (predicted.code.length == 0) {
            bytes32 salt = SALT;
            address deployed;
            assembly {
                deployed := create2(0, add(init, 0x20), mload(init), salt)
            }
            require(deployed == predicted, "create2 address mismatch");
        }
        vm.stopBroadcast();

        QalibreAccountFactory factory = QalibreAccountFactory(predicted);
        require(factory.settlement() == settlement, "factory points at the wrong settlement");
        vm.writeJson(vm.toString(predicted), path, ".accountFactory");
        vm.writeJson(vm.toString(address(factory.accountImplementation())), path, ".accountImplementation");
        console2.log("accountFactory v3       ", predicted);
        console2.log("accountImplementation v3", address(factory.accountImplementation()));
    }
}
