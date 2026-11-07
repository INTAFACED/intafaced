// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";
import {LiquidityFactory} from "./LiquidityFactory.sol";
import {LiquidityPool} from "./LiquidityPool.sol";

/**
 * LIQUIDITY ROUTER v2 — add, remove, create-and-seed and swap-and-add in one call each (D-liquidity-02, -03, -04).
 * Written for this repository; no code copied.
 *
 * The person's wallet calls it with its own approvals; it holds nothing between calls (anything it does not deposit is
 * sent back in the same call) and has no admin. It works only on pools its factory created. Every call carries the
 * person's bounds and a deadline, and reverts as a whole when one is not met:
 *   · `addLiquidity` deposits only the pool's ratio of what was offered (AMM-4) and needs at least `minShares`
 *   · `removeLiquidity` pays both tokens pro rata and needs at least both minimums (AMM-5)
 *   · `swapAndAdd` swaps the part of one token that leaves the rest at the pool's ratio, then adds both; if the add does
 *     not mint `minShares` the swap is undone with it, so nothing is ever left half done
 */
contract LiquidityRouter {
    uint256 private constant FEE_DENOM = 10_000;

    LiquidityFactory public immutable factory;

    error Expired();
    error NotAPool();
    error BadAmount();
    error InsufficientAmount0();
    error InsufficientAmount1();
    error InsufficientShares();
    error TransferFailed();

    constructor(LiquidityFactory factory_) {
        factory = factory_;
    }

    modifier before(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    // ── views ───────────────────────────────────────────────────────────────

    /** What `addLiquidity` deposits from the amounts offered, and the shares it mints, at the pool's reserves now. */
    function quoteAddLiquidity(LiquidityPool pool, uint256 amount0Desired, uint256 amount1Desired)
        public
        view
        returns (uint256 amount0, uint256 amount1, uint256 shares)
    {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        (amount0, amount1) = _optimal(r0, r1, amount0Desired, amount1Desired);
        shares = _sharesFor(pool, r0, r1, amount0, amount1);
    }

    /** How much of `amountIn` `swapAndAdd` swaps first, what that swap gives, and the shares the add then mints. */
    function quoteSwapAndAdd(LiquidityPool pool, address tokenIn, uint256 amountIn)
        external
        view
        returns (uint256 swapped, uint256 received, uint256 shares)
    {
        bool zeroIn = tokenIn == pool.token0();
        if (!zeroIn && tokenIn != pool.token1()) revert BadAmount();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        swapped = swapPart(zeroIn ? r0 : r1, amountIn, pool.feeBps());
        received = pool.getAmountOut(swapped, tokenIn);
        shares = _sharesAfterSwap(pool.totalSupply(), zeroIn, r0, r1, amountIn - swapped, swapped, received);
    }

    /** The shares an add of (kept, received) mints once the swap of `swapped` for `received` has moved the reserves. */
    function _sharesAfterSwap(
        uint256 supply,
        bool zeroIn,
        uint256 r0,
        uint256 r1,
        uint256 kept,
        uint256 swapped,
        uint256 received
    ) private pure returns (uint256) {
        (uint256 n0, uint256 n1) = zeroIn ? (r0 + swapped, r1 - received) : (r0 - received, r1 + swapped);
        (uint256 a0, uint256 a1) = zeroIn ? (kept, received) : (received, kept);
        (a0, a1) = _optimal(n0, n1, a0, a1);
        return _sharesAfter(supply, n0, n1, a0, a1);
    }

    /**
     * The part of `amountIn` to swap so that what is left and what the swap gives are in the pool's new ratio:
     * s = (sqrt(r^2 (D+g)^2 + 4 g D a r) - r (D+g)) / (2 g), with g = D - fee, the closed form of
     * (a - s) / (r + s) = out(s) / (R - out(s)) for a constant-product pool with the fee on the input.
     */
    function swapPart(uint256 reserveIn, uint256 amountIn, uint16 feeBps) public pure returns (uint256) {
        uint256 g = FEE_DENOM - uint256(feeBps);
        uint256 dg = FEE_DENOM + g;
        uint256 root = _sqrt(reserveIn * reserveIn * dg * dg + 4 * g * FEE_DENOM * amountIn * reserveIn);
        return (root - reserveIn * dg) / (2 * g);
    }

    // ── calls ───────────────────────────────────────────────────────────────

    /** Creates the pool for (tokenA, tokenB, feeBps) and makes its first deposit, which sets its price, in one call. */
    function createAndSeed(
        address tokenA,
        address tokenB,
        uint16 feeBps,
        uint256 amountA,
        uint256 amountB,
        uint256 minShares,
        address to,
        uint256 deadline
    ) external before(deadline) returns (address pool, uint256 shares) {
        if (amountA == 0 || amountB == 0 || to == address(0)) revert BadAmount();
        pool = factory.createPool(tokenA, tokenB, feeBps);
        LiquidityPool p = LiquidityPool(pool);
        (uint256 amount0, uint256 amount1) = tokenA == p.token0() ? (amountA, amountB) : (amountB, amountA);
        shares = _deposit(p, msg.sender, amount0, amount1, to);
        if (shares < minShares) revert InsufficientShares();
    }

    function addLiquidity(
        LiquidityPool pool,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 minShares,
        address to,
        uint256 deadline
    ) external before(deadline) returns (uint256 amount0, uint256 amount1, uint256 shares) {
        _requirePool(pool);
        if (to == address(0)) revert BadAmount();
        (uint112 r0, uint112 r1,) = pool.getReserves();
        (amount0, amount1) = _optimal(r0, r1, amount0Desired, amount1Desired);
        if (amount0 < amount0Min) revert InsufficientAmount0();
        if (amount1 < amount1Min) revert InsufficientAmount1();
        shares = _deposit(pool, msg.sender, amount0, amount1, to);
        if (shares < minShares) revert InsufficientShares();
    }

    /** Burns `shares` of the caller's (approved to this router) and pays both tokens to `to`. */
    function removeLiquidity(
        LiquidityPool pool,
        uint256 shares,
        uint256 amount0Min,
        uint256 amount1Min,
        address to,
        uint256 deadline
    ) external before(deadline) returns (uint256 amount0, uint256 amount1) {
        _requirePool(pool);
        if (shares == 0 || to == address(0)) revert BadAmount();
        if (!pool.transferFrom(msg.sender, address(this), shares)) revert TransferFailed();
        (amount0, amount1) = pool.burn(to, shares);
        if (amount0 < amount0Min) revert InsufficientAmount0();
        if (amount1 < amount1Min) revert InsufficientAmount1();
    }

    function swapAndAdd(
        LiquidityPool pool,
        address tokenIn,
        uint256 amountIn,
        uint256 minShares,
        address to,
        uint256 deadline
    ) external before(deadline) returns (uint256 swapped, uint256 shares) {
        _requirePool(pool);
        if (amountIn == 0 || to == address(0) || minShares == 0) revert BadAmount();
        bool zeroIn = tokenIn == pool.token0();
        if (!zeroIn && tokenIn != pool.token1()) revert BadAmount();

        _pull(tokenIn, msg.sender, amountIn);
        uint256 received;
        (swapped, received) = _swapPart(pool, tokenIn, zeroIn, amountIn);
        shares = _addHeld(pool, zeroIn, amountIn - swapped, received, to);
        if (shares < minShares) revert InsufficientShares();

        // What the add did not take goes back to the person in the same call.
        _sweep(pool.token0(), to);
        _sweep(pool.token1(), to);
    }

    /** Swaps the part of `amountIn` that leaves the rest at the pool's ratio; the output stays here for the add. */
    function _swapPart(LiquidityPool pool, address tokenIn, bool zeroIn, uint256 amountIn)
        private
        returns (uint256 swapped, uint256 received)
    {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        swapped = swapPart(zeroIn ? r0 : r1, amountIn, pool.feeBps());
        if (swapped == 0 || swapped >= amountIn) revert BadAmount();
        _approve(tokenIn, address(pool), swapped);
        received = pool.swapExactIn(tokenIn, swapped, 1, address(this));
    }

    /** Adds what this router holds from the swap, at the pool's ratio now, minting the shares to `to`. */
    function _addHeld(LiquidityPool pool, bool zeroIn, uint256 kept, uint256 received, address to) private returns (uint256) {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        (uint256 a0, uint256 a1) = zeroIn ? (kept, received) : (received, kept);
        (a0, a1) = _optimal(r0, r1, a0, a1);
        _approve(pool.token0(), address(pool), a0);
        _approve(pool.token1(), address(pool), a1);
        return pool.mint(to, a0, a1);
    }

    // ── internals ───────────────────────────────────────────────────────────

    function _requirePool(LiquidityPool pool) private view {
        address p = address(pool);
        if (p.code.length == 0) revert NotAPool();
        if (factory.getPool(pool.token0(), pool.token1(), pool.feeBps()) != p) revert NotAPool();
    }

    /** The pool's ratio of what was offered: all of one side, and the matching part of the other (AMM-4). */
    function _optimal(uint256 r0, uint256 r1, uint256 d0, uint256 d1) private pure returns (uint256, uint256) {
        if (d0 == 0 || d1 == 0) revert BadAmount();
        if (r0 == 0 && r1 == 0) return (d0, d1);
        uint256 b = (d0 * r1) / r0;
        if (b <= d1) return (d0, b);
        return ((d1 * r0) / r1, d1);
    }

    function _sharesFor(LiquidityPool pool, uint256 r0, uint256 r1, uint256 a0, uint256 a1) private view returns (uint256) {
        return _sharesAfter(pool.totalSupply(), r0, r1, a0, a1);
    }

    function _sharesAfter(uint256 supply, uint256 r0, uint256 r1, uint256 a0, uint256 a1) private pure returns (uint256) {
        if (supply == 0) {
            uint256 root = _sqrt(a0 * a1);
            return root > 1000 ? root - 1000 : 0;
        }
        uint256 s0 = (a0 * supply) / r0;
        uint256 s1 = (a1 * supply) / r1;
        return s0 < s1 ? s0 : s1;
    }

    function _deposit(LiquidityPool pool, address from, uint256 amount0, uint256 amount1, address to) private returns (uint256) {
        address t0 = pool.token0();
        address t1 = pool.token1();
        _pull(t0, from, amount0);
        _pull(t1, from, amount1);
        _approve(t0, address(pool), amount0);
        _approve(t1, address(pool), amount1);
        return pool.mint(to, amount0, amount1);
    }

    function _pull(address token, address from, uint256 amount) private {
        if (!IERC20Minimal(token).transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _approve(address token, address spender, uint256 amount) private {
        if (!IERC20Minimal(token).approve(spender, amount)) revert TransferFailed();
    }

    function _sweep(address token, address to) private {
        uint256 left = IERC20Minimal(token).balanceOf(address(this));
        if (left > 0 && !IERC20Minimal(token).transfer(to, left)) revert TransferFailed();
    }

    function _sqrt(uint256 y) private pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
