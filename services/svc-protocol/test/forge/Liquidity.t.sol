// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LiquidityFactory} from "../../contracts/liquidity/LiquidityFactory.sol";
import {LiquidityPool} from "../../contracts/liquidity/LiquidityPool.sol";
import {LiquidityRouter} from "../../contracts/liquidity/LiquidityRouter.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// Foundry cheatcodes without vendoring forge-std (no submodule).
interface Vm {
    function expectRevert(bytes4) external;
    function expectRevert() external;
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// A token that re-enters the pool from inside a transfer (amm.reentrancy.hook-token-cannot-reenter).
contract ReenterToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    LiquidityPool public target;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(LiquidityPool pool) external {
        target = pool;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (address(target) != address(0)) target.sync();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// D-liquidity-01..04 (J-dex-protocol-12): v2 pool, factory and router. TEST tokens only.
contract LiquidityTest {
    MockERC20 internal a;
    MockERC20 internal b;
    LiquidityFactory internal factory;
    LiquidityRouter internal router;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);

    function _setUp() internal {
        a = new MockERC20();
        b = new MockERC20();
        factory = new LiquidityFactory();
        router = new LiquidityRouter(factory);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? ALICE : BOB;
            a.mint(who, 1_000_000 ether);
            b.mint(who, 1_000_000 ether);
            vm.startPrank(who);
            a.approve(address(router), type(uint256).max);
            b.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// A 1000:2000 pool (in a:b) at `fee` bps, seeded by ALICE.
    function _pool(uint16 fee) internal returns (LiquidityPool pool) {
        vm.prank(ALICE);
        (address p,) = router.createAndSeed(address(a), address(b), fee, 1000 ether, 2000 ether, 1, ALICE, block.timestamp);
        pool = LiquidityPool(p);
    }

    function _amounts(LiquidityPool pool, uint256 x, uint256 y) internal view returns (uint256, uint256) {
        return pool.token0() == address(a) ? (x, y) : (y, x);
    }

    function _reservesAB(LiquidityPool pool) internal view returns (uint256 ra, uint256 rb) {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        (ra, rb) = pool.token0() == address(a) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    function test_create_and_seed_sets_price_to_deposit_ratio_and_one_pool_per_pair_and_fee() public {
        _setUp();
        LiquidityPool pool = _pool(30);
        (uint256 ra, uint256 rb) = _reservesAB(pool);
        require(ra == 1000 ether && rb == 2000 ether, "price is the deposit ratio");
        require(factory.getPool(address(a), address(b), 30) == address(pool), "listed");
        require(factory.predictPoolAddress(address(b), address(a), 30) == address(pool), "predicted");
        vm.expectRevert(LiquidityFactory.PoolExists.selector);
        factory.createPool(address(b), address(a), 30);
        vm.expectRevert(LiquidityFactory.FeeAboveCap.selector);
        factory.createPool(address(a), address(b), 1001);
        // a second fee tier of the same pair is its own pool
        require(factory.createPool(address(a), address(b), 100) != address(pool), "second tier");
    }

    function test_add_100_100_into_1000_2000_pulls_only_50_100() public {
        _setUp();
        LiquidityPool pool = _pool(30);
        (uint256 d0, uint256 d1) = _amounts(pool, 100 ether, 100 ether);
        (uint256 q0, uint256 q1, uint256 qShares) = router.quoteAddLiquidity(pool, d0, d1);
        uint256 aBefore = a.balanceOf(BOB);
        uint256 bBefore = b.balanceOf(BOB);
        vm.prank(BOB);
        (uint256 got0, uint256 got1, uint256 shares) = router.addLiquidity(pool, d0, d1, 0, 0, qShares, BOB, block.timestamp);
        require(got0 == q0 && got1 == q1 && shares == qShares, "quote matches the call");
        require(aBefore - a.balanceOf(BOB) == 50 ether, "50 a pulled");
        require(bBefore - b.balanceOf(BOB) == 100 ether, "100 b pulled");
        require(pool.balanceOf(BOB) == shares, "shares are BOB's");
        require(a.balanceOf(address(router)) == 0 && b.balanceOf(address(router)) == 0, "router holds nothing");
    }

    function test_add_with_a_minimum_above_what_the_pool_takes_reverts_and_moves_nothing() public {
        _setUp();
        LiquidityPool pool = _pool(30);
        (uint256 d0, uint256 d1) = _amounts(pool, 100 ether, 100 ether);
        (,, uint256 qShares) = router.quoteAddLiquidity(pool, d0, d1);
        uint256 aBefore = a.balanceOf(BOB);
        vm.prank(BOB);
        vm.expectRevert(LiquidityRouter.InsufficientShares.selector);
        router.addLiquidity(pool, d0, d1, 0, 0, qShares + 1, BOB, block.timestamp);
        // a minimum of 60 a, when the pool takes only 50
        (uint256 m0, uint256 m1) = _amounts(pool, 60 ether, 0);
        vm.prank(BOB);
        vm.expectRevert(pool.token0() == address(a) ? LiquidityRouter.InsufficientAmount0.selector : LiquidityRouter.InsufficientAmount1.selector);
        router.addLiquidity(pool, d0, d1, m0, m1, 1, BOB, block.timestamp);
        require(a.balanceOf(BOB) == aBefore, "nothing moved");
    }

    function test_an_expired_call_reverts() public {
        _setUp();
        LiquidityPool pool = _pool(30);
        vm.warp(block.timestamp + 100);
        vm.prank(BOB);
        vm.expectRevert(LiquidityRouter.Expired.selector);
        router.addLiquidity(pool, 1 ether, 1 ether, 0, 0, 1, BOB, block.timestamp - 1);
    }

    function test_shares_are_a_token_sum_of_balances_is_supply_and_a_moved_share_is_the_receivers() public {
        _setUp();
        LiquidityPool pool = _pool(30);
        uint256 alice = pool.balanceOf(ALICE);
        vm.prank(ALICE);
        pool.transfer(BOB, 1 ether);
        require(pool.balanceOf(BOB) == 1 ether && pool.balanceOf(ALICE) == alice - 1 ether, "moved");
        require(pool.totalSupply() == pool.balanceOf(ALICE) + pool.balanceOf(BOB) + pool.balanceOf(address(0)), "supply = sum");
        // BOB removes the share he received: it pays him, as its holder.
        vm.startPrank(BOB);
        pool.approve(address(router), 1 ether);
        (uint256 out0, uint256 out1) = router.removeLiquidity(pool, 1 ether, 1, 1, BOB, block.timestamp);
        vm.stopPrank();
        require(out0 > 0 && out1 > 0, "paid");
    }

    function test_remove_all_pays_both_pro_rata_and_leaves_no_shares() public {
        _setUp();
        LiquidityPool pool = _pool(30);
        (uint256 d0, uint256 d1) = _amounts(pool, 100 ether, 200 ether);
        vm.prank(BOB);
        (,, uint256 shares) = router.addLiquidity(pool, d0, d1, 0, 0, 1, BOB, block.timestamp);
        uint256 supply = pool.totalSupply();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        vm.startPrank(BOB);
        pool.approve(address(router), shares);
        (uint256 out0, uint256 out1) = router.removeLiquidity(pool, shares, 0, 0, BOB, block.timestamp);
        vm.stopPrank();
        require(out0 == (shares * r0) / supply && out1 == (shares * r1) / supply, "pro rata");
        require(pool.balanceOf(BOB) == 0, "no shares left");
    }

    function test_swap_fees_compound_into_the_shares() public {
        _setUp();
        LiquidityPool pool = _pool(30);
        uint256 supply = pool.totalSupply();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 kBefore = uint256(r0) * uint256(r1);
        vm.startPrank(BOB);
        a.approve(address(pool), type(uint256).max);
        b.approve(address(pool), type(uint256).max);
        pool.swapExactIn(address(a), 100 ether, 1, BOB);
        pool.swapExactIn(address(b), 150 ether, 1, BOB);
        vm.stopPrank();
        (r0, r1,) = pool.getReserves();
        require(uint256(r0) * uint256(r1) > kBefore, "k grew by the fees");
        require(pool.totalSupply() == supply, "no shares were minted for the fees");
    }

    function test_swap_and_add_swaps_about_half_and_mints_at_least_the_minimum() public {
        _setUp();
        vm.prank(ALICE);
        (address p,) = router.createAndSeed(address(a), address(b), 30, 1000 ether, 1000 ether, 1, ALICE, block.timestamp);
        LiquidityPool pool = LiquidityPool(p);
        (uint256 swapped,, uint256 quoted) = router.quoteSwapAndAdd(pool, address(a), 100 ether);
        require(swapped > 48 ether && swapped < 50 ether, "about half");
        uint256 aBefore = a.balanceOf(BOB);
        vm.prank(BOB);
        (uint256 did, uint256 shares) = router.swapAndAdd(pool, address(a), 100 ether, quoted, BOB, block.timestamp);
        require(did == swapped && shares >= quoted, "at least the minimum");
        require(aBefore - a.balanceOf(BOB) <= 100 ether, "never more than offered");
        require(a.balanceOf(address(router)) == 0 && b.balanceOf(address(router)) == 0, "router holds nothing");
    }

    function test_swap_and_add_whose_add_fails_undoes_the_swap() public {
        _setUp();
        LiquidityPool pool = _pool(30);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 aBefore = a.balanceOf(BOB);
        uint256 bBefore = b.balanceOf(BOB);
        vm.prank(BOB);
        vm.expectRevert(LiquidityRouter.InsufficientShares.selector);
        router.swapAndAdd(pool, address(a), 100 ether, type(uint256).max, BOB, block.timestamp);
        (uint112 s0, uint112 s1,) = pool.getReserves();
        require(s0 == r0 && s1 == r1, "pool unchanged");
        require(a.balanceOf(BOB) == aBefore && b.balanceOf(BOB) == bBefore, "wallet keeps its token");
    }

    function test_a_donation_cannot_lock_the_pool() public {
        _setUp();
        LiquidityPool pool = _pool(30);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        a.mint(address(pool), 5 ether);
        uint256 before = a.balanceOf(BOB);
        pool.skim(BOB);
        require(a.balanceOf(BOB) == before + 5 ether, "excess skimmed to the named address");
        (uint112 s0, uint112 s1,) = pool.getReserves();
        require(s0 == r0 && s1 == r1, "price unchanged");
    }

    function test_a_hook_token_cannot_reenter() public {
        _setUp();
        ReenterToken hook = new ReenterToken();
        hook.mint(ALICE, 1_000 ether);
        address p = factory.createPool(address(hook), address(b), 30);
        hook.arm(LiquidityPool(p));
        vm.startPrank(ALICE);
        hook.approve(p, type(uint256).max);
        b.approve(p, type(uint256).max);
        vm.expectRevert(LiquidityPool.Locked.selector);
        LiquidityPool(p).mint(ALICE, 100 ether, 100 ether);
        vm.stopPrank();
    }

    function test_router_refuses_a_pool_its_factory_did_not_create() public {
        _setUp();
        LiquidityPool stray = new LiquidityPool(address(a), address(b), 30);
        vm.prank(BOB);
        vm.expectRevert(LiquidityRouter.NotAPool.selector);
        router.addLiquidity(stray, 1 ether, 1 ether, 0, 0, 1, BOB, block.timestamp);
    }

    /// amm.add-then-remove-never-profits, and k never falls after a swap.
    function testFuzz_add_then_remove_never_profits(uint96 x, uint96 y, uint96 swapIn) public {
        _setUp();
        LiquidityPool pool = _pool(30);
        uint256 dx = uint256(x) % 10_000 ether + 1 ether;
        uint256 dy = uint256(y) % 10_000 ether + 1 ether;
        uint256 aBefore = a.balanceOf(BOB);
        uint256 bBefore = b.balanceOf(BOB);
        (uint256 d0, uint256 d1) = _amounts(pool, dx, dy);
        vm.startPrank(BOB);
        (,, uint256 shares) = router.addLiquidity(pool, d0, d1, 0, 0, 1, BOB, block.timestamp);
        pool.approve(address(router), shares);
        router.removeLiquidity(pool, shares, 0, 0, BOB, block.timestamp);
        vm.stopPrank();
        require(a.balanceOf(BOB) <= aBefore && b.balanceOf(BOB) <= bBefore, "never profits");
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 k = uint256(r0) * uint256(r1);
        vm.startPrank(BOB);
        a.approve(address(pool), type(uint256).max);
        pool.swapExactIn(address(a), uint256(swapIn) % 500 ether + 1 ether, 1, BOB);
        vm.stopPrank();
        (r0, r1,) = pool.getReserves();
        require(uint256(r0) * uint256(r1) >= k, "k non-decreasing");
    }
}
