// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConstantProductPool} from "../../contracts/amm/ConstantProductPool.sol";
import {SovereignRouter} from "../../contracts/router/SovereignRouter.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// Foundry cheatcodes without vendoring forge-std (no submodule).
interface Vm {
    function expectRevert(bytes calldata) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// CHN-0029 — swapExactIn(minAmountOut = 0) reverts and no balance moves.
/// The zero check runs before any pull. A minimum above the quote still
/// reverts on the existing strict `<` check. A minimum of 1 wei against a
/// funded pool still settles, so the backstop is zero, not every swap.
contract SwapMinOutTest {
    uint256 internal constant SEED = 100 ether;
    uint256 internal constant AMOUNT_IN = 1 ether;

    MockERC20 internal tokenA;
    MockERC20 internal tokenB;
    ConstantProductPool internal pool;
    SovereignRouter internal router;

    function _seed() internal {
        tokenA = new MockERC20();
        tokenB = new MockERC20();
        pool = new ConstantProductPool(address(tokenA), address(tokenB), 30);
        router = new SovereignRouter();
        tokenA.mint(address(this), SEED * 4);
        tokenB.mint(address(this), SEED * 4);
        tokenA.approve(address(pool), type(uint256).max);
        tokenB.approve(address(pool), type(uint256).max);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
        pool.mint(address(this), SEED, SEED);
    }

    function _token0() internal view returns (MockERC20) {
        return MockERC20(pool.token0());
    }

    function test_chn_0029_pool_zero_min_reverts_and_moves_nothing() public {
        _seed();
        MockERC20 tokenIn = _token0();
        uint256 userBefore = tokenIn.balanceOf(address(this));
        uint256 poolBefore = tokenIn.balanceOf(address(pool));

        vm.expectRevert(abi.encodeWithSelector(ConstantProductPool.InsufficientOutput.selector));
        pool.swapExactIn(address(tokenIn), AMOUNT_IN, 0, address(this));

        require(tokenIn.balanceOf(address(this)) == userBefore, "user balance moved");
        require(tokenIn.balanceOf(address(pool)) == poolBefore, "pool balance moved");
    }

    function test_chn_0029_router_zero_min_reverts_and_moves_nothing() public {
        _seed();
        MockERC20 tokenIn = _token0();
        uint256 userBefore = tokenIn.balanceOf(address(this));
        uint256 routerBefore = tokenIn.balanceOf(address(router));
        uint256 poolBefore = tokenIn.balanceOf(address(pool));

        vm.expectRevert(abi.encodeWithSelector(SovereignRouter.InsufficientOut.selector));
        router.swapExactIn(address(pool), address(tokenIn), AMOUNT_IN, 0, address(this));

        require(tokenIn.balanceOf(address(this)) == userBefore, "user balance moved");
        require(tokenIn.balanceOf(address(router)) == routerBefore, "router balance moved");
        require(tokenIn.balanceOf(address(pool)) == poolBefore, "pool balance moved");
    }

    function test_pool_min_above_output_still_reverts() public {
        _seed();
        MockERC20 tokenIn = _token0();
        uint256 userBefore = tokenIn.balanceOf(address(this));
        vm.expectRevert(abi.encodeWithSelector(ConstantProductPool.InsufficientOutput.selector));
        pool.swapExactIn(address(tokenIn), AMOUNT_IN, type(uint256).max, address(this));
        require(tokenIn.balanceOf(address(this)) == userBefore, "user balance moved");
    }

    function test_pool_min_of_one_still_swaps() public {
        _seed();
        MockERC20 tokenIn = _token0();
        MockERC20 tokenOut = MockERC20(pool.token1());
        uint256 outBefore = tokenOut.balanceOf(address(this));
        uint256 got = pool.swapExactIn(address(tokenIn), AMOUNT_IN, 1, address(this));
        require(got > 1, "quote was dust");
        require(tokenOut.balanceOf(address(this)) == outBefore + got, "output not delivered");
    }
}
