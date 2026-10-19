// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CrewVault} from "../../contracts/vaults/CrewVault.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

interface Vm {
    function prank(address) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// S-A8: construction invariant — share bps sum to 10_000 or the vault does not exist.
contract CrewVaultForgeTest {
    function test_two_members_even_split_deploys() public {
        address[] memory members = new address[](2);
        members[0] = address(0xA11CE);
        members[1] = address(0xB0B);
        uint16[] memory shares = new uint16[](2);
        shares[0] = 5_000;
        shares[1] = 5_000;
        CrewVault v = new CrewVault(address(1), members, shares, 1);
        require(v.shareBps(members[0]) + v.shareBps(members[1]) == 10_000, "shares");
    }

    function testFuzz_shares_must_sum_10000(uint16 a, uint16 b) public {
        address[] memory members = new address[](2);
        members[0] = address(0xA11CE);
        members[1] = address(0xB0B);
        uint16[] memory shares = new uint16[](2);
        shares[0] = a;
        shares[1] = b;
        uint256 sum = uint256(a) + uint256(b);
        bool legal = a > 0 && b > 0 && sum == 10_000;
        try new CrewVault(address(1), members, shares, 1) returns (CrewVault v) {
            require(legal, "illegal config deployed");
            require(v.shareBps(members[0]) == a && v.shareBps(members[1]) == b, "stored");
        } catch {
            require(!legal, "legal config reverted");
        }
    }

    function test_construct_gas_ceiling() public {
        address[] memory members = new address[](2);
        members[0] = address(0xA11CE);
        members[1] = address(0xB0B);
        uint16[] memory shares = new uint16[](2);
        shares[0] = 5_000;
        shares[1] = 5_000;
        uint256 start = gasleft();
        new CrewVault(address(1), members, shares, 1);
        uint256 used = start - gasleft();
        require(used < 1_200_000, "CrewVault construct gas drifted");
    }

    /// Equal shares of an untouched balance pay the same on each exit. The vault ends empty.
    function test_exit_two_equal() public {
        MockERC20 token = new MockERC20();
        address[] memory members = new address[](2);
        members[0] = address(0xA11CE);
        members[1] = address(0xB0B);
        uint16[] memory shares = new uint16[](2);
        shares[0] = 5_000;
        shares[1] = 5_000;
        CrewVault vault = new CrewVault(address(token), members, shares, 1);
        token.mint(address(this), 100);
        token.approve(address(vault), 100);
        vault.deposit(100);

        vm.prank(members[0]);
        vault.exit();
        require(token.balanceOf(members[0]) == 50, "first exit");

        vm.prank(members[1]);
        vault.exit();
        require(token.balanceOf(members[1]) == 50, "second exit");
        require(token.balanceOf(address(vault)) == 0, "vault empty");
        require(token.balanceOf(members[0]) <= token.balanceOf(members[1]), "first paid more");
    }
}
