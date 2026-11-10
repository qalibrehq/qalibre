// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IEntryPoint} from "account-abstraction/interfaces/IEntryPoint.sol";

import {QalibreSettlement} from "../src/QalibreSettlement.sol";
import {QalibreAccountFactory} from "../src/QalibreAccountFactory.sol";
import {QalibrePaymaster} from "../src/QalibrePaymaster.sol";
import {QwapV2Adapter, IQwapRouter} from "../src/adapters/QwapV2Adapter.sol";

/// @notice One-command deploy of the whole Qalibre stack.
///
///   forge script script/Deploy.s.sol --rpc-url qms --broadcast --slow
///
/// Uses CREATE2 (the standard deployer at 0x4e59...956C, pre-deployed on QMS), so with the same deployer
/// key and settings the contracts land at the SAME addresses after a testnet reset. Re-running when they
/// already exist skips deployment and only re-applies configuration. Addresses are written to
/// deployments/<chainId>.json for the solver, bot and mini app.
contract Deploy is Script {
    // QMS testnet (verified 2026-11-10 on testnet.qmsscan.io).
    address constant ENTRY_POINT_V07 = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address constant QWAP_ROUTER = 0x93AFF45f28e5DF1b55f5AEFEfB807De843b12619;

    bytes32 constant SALT = keccak256("qalibre.v1");

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        address solver = vm.envAddress("SOLVER_ADDRESS");
        address sponsor = vm.envAddress("SPONSOR_SIGNER_ADDRESS");
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        uint256 feeBps = vm.envOr("FEE_BPS", uint256(20)); // 0.20% cap per trade
        uint256 surplusShareBps = vm.envOr("SURPLUS_SHARE_BPS", uint256(2_000)); // 20% of savings
        uint256 paymasterDeposit = vm.envOr("PAYMASTER_DEPOSIT_WEI", uint256(2 ether));
        address entryPoint = vm.envOr("ENTRY_POINT", ENTRY_POINT_V07);
        address qwapRouter = vm.envOr("QWAP_ROUTER", QWAP_ROUTER);

        require(entryPoint.code.length > 0, "EntryPoint v0.7 not deployed on this chain");
        require(qwapRouter.code.length > 0, "QWAP router not found on this chain");

        vm.startBroadcast(deployerPk);

        // Owner is the deployer (constant), fee settings go through setters so they don't change addresses.
        QalibreSettlement settlement = QalibreSettlement(
            _deploy(abi.encodePacked(type(QalibreSettlement).creationCode, abi.encode(deployer, deployer, 0, 0)))
        );
        QalibreAccountFactory factory = QalibreAccountFactory(
            _deploy(
                abi.encodePacked(
                    type(QalibreAccountFactory).creationCode, abi.encode(IEntryPoint(entryPoint), address(settlement))
                )
            )
        );
        QwapV2Adapter qwap = QwapV2Adapter(
            _deploy(
                abi.encodePacked(
                    type(QwapV2Adapter).creationCode, abi.encode(IQwapRouter(qwapRouter), address(settlement))
                )
            )
        );
        QalibrePaymaster paymaster = QalibrePaymaster(
            payable(
                _deploy(
                    abi.encodePacked(type(QalibrePaymaster).creationCode, abi.encode(IEntryPoint(entryPoint), sponsor, deployer))
                )
            )
        );

        // Ownership must be the deployer, never the CREATE2 factory.
        require(settlement.owner() == deployer, "settlement owner mismatch");
        require(paymaster.owner() == deployer, "paymaster owner mismatch");

        // Configuration (idempotent).
        if (settlement.feeRecipient() != feeRecipient) settlement.setFeeRecipient(feeRecipient);
        if (settlement.feeBps() != feeBps) settlement.setFee(feeBps);
        if (settlement.surplusShareBps() != surplusShareBps) settlement.setSurplusShare(surplusShareBps);
        if (!settlement.isSolver(solver)) settlement.setSolver(solver, true);
        if (!settlement.isAdapter(address(qwap))) settlement.setAdapter(address(qwap), true);
        if (paymaster.getDeposit() < paymasterDeposit) {
            paymaster.deposit{value: paymasterDeposit - paymaster.getDeposit()}();
        }

        vm.stopBroadcast();

        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployedAtBlock", block.number);
        vm.serializeAddress(k, "entryPoint", entryPoint);
        vm.serializeAddress(k, "qwapRouter", qwapRouter);
        vm.serializeAddress(k, "settlement", address(settlement));
        vm.serializeAddress(k, "accountFactory", address(factory));
        vm.serializeAddress(k, "accountImplementation", address(factory.accountImplementation()));
        vm.serializeAddress(k, "qwapAdapter", address(qwap));
        vm.serializeAddress(k, "paymaster", address(paymaster));
        vm.serializeAddress(k, "solver", solver);
        vm.serializeAddress(k, "sponsorSigner", sponsor);
        string memory json = vm.serializeAddress(k, "owner", deployer);
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);

        console2.log("settlement     ", address(settlement));
        console2.log("accountFactory ", address(factory));
        console2.log("qwapAdapter    ", address(qwap));
        console2.log("paymaster      ", address(paymaster));
        console2.log("written to     ", path);
    }

    /// @dev CREATE2 through the standard deterministic deployer; skips if already deployed.
    function _deploy(bytes memory initCode) internal returns (address addr) {
        addr = vm.computeCreate2Address(SALT, keccak256(initCode));
        if (addr.code.length > 0) return addr;
        address deployed;
        bytes32 salt = SALT;
        assembly {
            deployed := create2(0, add(initCode, 0x20), mload(initCode), salt)
        }
        // Inside a broadcast, forge routes `create2` through CREATE2_FACTORY, so `deployed` == addr.
        require(deployed == addr && addr.code.length > 0, "create2 failed");
    }
}
