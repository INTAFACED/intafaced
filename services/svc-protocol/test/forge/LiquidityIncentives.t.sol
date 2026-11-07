// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LiquidityIncentives} from "../../contracts/liquidity/LiquidityIncentives.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

interface Vm {
    function expectRevert(bytes4) external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function roll(uint256) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// D-liquidity-09 (J-dex-protocol-13 #8): TEST shares and a TEST reward token.
contract LiquidityIncentivesTest {
    LiquidityIncentives internal inc;
    MockERC20 internal shares;
    MockERC20 internal reward;
    address internal constant FUNDER = address(0xF00D);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    function _setUp() internal returns (uint256 id) {
        inc = new LiquidityIncentives();
        shares = new MockERC20();
        reward = new MockERC20();
        reward.mint(FUNDER, 1000 ether);
        shares.mint(ALICE, 300 ether);
        shares.mint(BOB, 100 ether);
        for (uint256 k = 0; k < 2; k++) {
            address who = k == 0 ? ALICE : BOB;
            vm.prank(who);
            shares.approve(address(inc), type(uint256).max);
        }
        vm.startPrank(FUNDER);
        reward.approve(address(inc), type(uint256).max);
        id = inc.create(address(shares), address(reward), 1000 ether, 10, FUNDER);
        vm.stopPrank();
    }

    function test_an_unfunded_incentive_cannot_start() public {
        uint256 id = _setUp();
        vm.prank(FUNDER);
        vm.expectRevert(LiquidityIncentives.NotFunded.selector);
        inc.start(id);
    }

    function test_1000_over_10_blocks_splits_750_250_for_holders_of_3_to_1() public {
        uint256 id = _setUp();
        vm.prank(ALICE);
        inc.stake(id, 300 ether);
        vm.prank(BOB);
        inc.stake(id, 100 ether);
        vm.startPrank(FUNDER);
        inc.fund(id);
        inc.start(id);
        vm.stopPrank();
        vm.roll(block.number + 10);
        require(inc.pending(id, ALICE) == 750 ether, "alice 750");
        require(inc.pending(id, BOB) == 250 ether, "bob 250");
        vm.prank(ALICE);
        require(inc.claim(id) == 750 ether, "alice paid");
        vm.prank(BOB);
        require(inc.claim(id) == 250 ether, "bob paid");
        require(reward.balanceOf(address(inc)) == 0, "paid never exceeds funded, and all of it");
    }

    function test_leaving_mid_period_stops_accrual() public {
        uint256 id = _setUp();
        vm.prank(ALICE);
        inc.stake(id, 300 ether);
        vm.prank(BOB);
        inc.stake(id, 100 ether);
        vm.startPrank(FUNDER);
        inc.fund(id);
        inc.start(id);
        vm.stopPrank();
        vm.roll(block.number + 4);
        vm.prank(ALICE);
        inc.unstake(id);
        uint256 atExit = inc.pending(id, ALICE);
        require(atExit == 300 ether, "4 blocks of 100, three quarters");
        vm.roll(block.number + 6);
        require(inc.pending(id, ALICE) == atExit, "no accrual after leaving");
        require(inc.pending(id, BOB) == 100 ether + 600 ether, "bob alone after alice left");
        require(shares.balanceOf(ALICE) == 300 ether, "shares back");
    }

    function test_refund_waits_for_the_end_of_the_period() public {
        uint256 id = _setUp();
        vm.startPrank(FUNDER);
        inc.fund(id);
        inc.start(id);
        vm.stopPrank();
        vm.roll(block.number + 5);
        vm.expectRevert(LiquidityIncentives.NotEnded.selector);
        inc.refund(id);
    }

    function test_refund_pays_the_refundee_what_nobody_earned() public {
        uint256 id = _setUp();
        vm.startPrank(FUNDER);
        inc.fund(id);
        inc.start(id);
        vm.stopPrank();
        vm.roll(block.number + 5);
        vm.prank(BOB);
        inc.stake(id, 100 ether);
        vm.roll(block.number + 5);
        uint256 before = reward.balanceOf(FUNDER);
        require(inc.refund(id) == 500 ether, "first five blocks had no stake");
        require(reward.balanceOf(FUNDER) - before == 500 ether, "refunded");
        require(inc.pending(id, BOB) == 500 ether, "bob earned the rest");
    }

    function testFuzz_paid_never_exceeds_funded(uint8 a, uint8 b, uint8 exitAt) public {
        uint256 id = _setUp();
        uint256 sa = uint256(a) % 300 ether + 1;
        uint256 sb = uint256(b) % 100 ether + 1;
        vm.prank(ALICE);
        inc.stake(id, sa);
        vm.prank(BOB);
        inc.stake(id, sb);
        vm.startPrank(FUNDER);
        inc.fund(id);
        inc.start(id);
        vm.stopPrank();
        vm.roll(block.number + (exitAt % 10));
        vm.prank(ALICE);
        inc.unstake(id);
        vm.roll(block.number + 20);
        uint256 total = inc.pending(id, ALICE) + inc.pending(id, BOB) + inc.refund(id);
        require(total <= 1000 ether, "never more than funded");
        require(1000 ether - total < 10, "only rounding dust left");
    }
}
