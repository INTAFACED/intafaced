// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LegacyVault} from "../../contracts/vaults/LegacyVault.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// Foundry cheatcodes without vendoring forge-std (no submodule).
interface Vm {
    function prank(address) external;
    function warp(uint256) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/**
 * Amounts are the LegacyVault on-chain suite: 100 tokens in, 10 withdrawn,
 * heirs 60/40, first tranche 50% so the first claim is 27.
 */
contract LegacyVaultForgeTest {
    uint256 internal constant WAD = 10 ** 18;

    function test_next_succession_rereads_live_balance_after_abort_or_new_heirs() public {
        MockERC20 token = new MockERC20();
        address heirA = address(0xA11CE);
        address heirB = address(0xB0B);
        address[] memory accounts = new address[](2);
        accounts[0] = heirA;
        accounts[1] = heirB;
        uint16[] memory shares = new uint16[](2);
        shares[0] = 6_000;
        shares[1] = 4_000;

        LegacyVault vault = new LegacyVault(address(token), 100, 50, 80, 5_000, accounts, shares);

        token.mint(address(this), 100 * WAD);
        token.approve(address(vault), 100 * WAD);
        vault.deposit(100 * WAD);
        vault.withdraw(10 * WAD);

        vm.warp(block.timestamp + 101);
        vault.startSuccession();
        vm.warp(block.timestamp + 51);

        vm.prank(heirA);
        vault.claim(0);
        require(token.balanceOf(heirA) == 27 * WAD, "first tranche");
        require(vault.successionStartedAt() != 0, "succession active");

        vault.heartbeat();
        require(vault.successionStartedAt() == 0, "heartbeat aborted");

        vault.setHeirs(accounts, shares);

        token.mint(address(this), 100 * WAD);
        token.approve(address(vault), 100 * WAD);
        vault.deposit(100 * WAD);

        vm.warp(block.timestamp + 101);
        vault.startSuccession();
        require(vault.successionStartedAt() != 0, "next succession");
        vm.warp(block.timestamp + 51);

        uint256 before = token.balanceOf(heirA);
        vm.prank(heirA);
        vault.claim(0);

        // 100 deposited, 10 withdrawn, 27 already paid, 100 deposited again.
        // 163 * 60% * 50% = 48.9 tokens. The latched remainder would still be 27.
        uint256 expected = 489 * 10 ** 17;
        require(token.balanceOf(heirA) - before == expected, "live balance share");
        require(vault.estate() == 163 * WAD, "estate reread");
    }
}
