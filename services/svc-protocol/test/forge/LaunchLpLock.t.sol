// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConstantProductPool} from "../../contracts/amm/ConstantProductPool.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";
import {LaunchLpLock} from "../../contracts/trust/LaunchLpLock.sol";

interface Vm {
    function warp(uint256 newTimestamp) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// Minted pool shares are the lock. `lock()` is not required. `claim` burns them after unlockTime.
contract LaunchLpLockForgeTest {
    uint256 private constant MINIMUM_LIQUIDITY = 1_000;

    function test_claim_burns_minted_shares() public {
        MockERC20 a = new MockERC20();
        MockERC20 b = new MockERC20();
        ConstantProductPool pool = new ConstantProductPool(address(a), address(b), 30);

        address beneficiary = address(0xBEEF);
        uint64 unlockTime = uint64(block.timestamp + 1 days);
        LaunchLpLock lock = new LaunchLpLock(address(pool), beneficiary, unlockTime);

        uint256 deposit = 10_000 ether;
        a.mint(address(this), deposit);
        b.mint(address(this), deposit);
        a.approve(address(pool), deposit);
        b.approve(address(pool), deposit);

        // Shares minted to the lock. `locked` stays 0 because nobody calls lock().
        uint256 liquidity = pool.mint(address(lock), deposit, deposit);
        require(liquidity > 0, "no shares");
        require(lock.locked() == 0, "locked must stay 0");
        require(pool.balanceOf(address(lock)) == liquidity, "shares not on lock");
        require(pool.balanceOf(address(0)) == MINIMUM_LIQUIDITY, "minimum not at zero");

        try lock.claim() {
            revert("claim before unlock");
        } catch {}
        require(pool.balanceOf(address(lock)) == liquidity, "early claim moved shares");
        require(pool.balanceOf(address(0)) == MINIMUM_LIQUIDITY, "early claim moved minimum");

        vm.warp(unlockTime);
        // Must not revert BadAmount: burn pool.balanceOf(lock) to the beneficiary.
        lock.claim();

        require(pool.balanceOf(address(lock)) == 0, "shares not burned");
        require(pool.balanceOf(address(0)) == MINIMUM_LIQUIDITY, "minimum left address(0)");
        require(a.balanceOf(address(pool)) == MINIMUM_LIQUIDITY, "token a still seeded");
        require(b.balanceOf(address(pool)) == MINIMUM_LIQUIDITY, "token b still seeded");
        require(a.balanceOf(beneficiary) == deposit - MINIMUM_LIQUIDITY, "beneficiary a");
        require(b.balanceOf(beneficiary) == deposit - MINIMUM_LIQUIDITY, "beneficiary b");
        require(lock.locked() == 0, "claim invented a lock balance");

        try lock.claim() {
            revert("second claim");
        } catch {}
        require(pool.balanceOf(address(0)) == MINIMUM_LIQUIDITY, "second claim moved minimum");
        require(a.balanceOf(beneficiary) == deposit - MINIMUM_LIQUIDITY, "second claim paid again");
    }
}
