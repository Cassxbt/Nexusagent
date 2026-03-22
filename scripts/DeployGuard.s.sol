// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/NexusGuard.sol";

contract DeployGuard is Script {
    function run() external {
        vm.startBroadcast();
        NexusGuard guard = new NexusGuard(
            500_000_000,   // $500 max per tx (6 decimals)
            2_000_000_000, // $2000 daily limit
            100,           // 1% max slippage (bps)
            0              // no cooldown
        );
        vm.stopBroadcast();
        console.log("NexusGuard deployed to:", address(guard));
    }
}
