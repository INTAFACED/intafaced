// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";

interface IConstantProductPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function feeBps() external view returns (uint16);
    function getReserves() external view returns (uint112, uint112, uint32);
    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256);
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut);
}

/**
 * SOVEREIGN ROUTER — Protocol Plane (board S-A5 / `protocol.router`).
 *
 * On-chain execution is pool-only. Book quotes are compared off-chain (TypeScript)
 * from real matching marks — never invented here.
 *
 * `swapExactIn` fails closed on slippage (`minAmountOut`). No admin, no invented mid.
 */
contract SovereignRouter {
    error BadPool();
    error BadAmount();
    error TransferFailed();
    error InsufficientOut();

    function quoteExactIn(address pool, address tokenIn, uint256 amountIn) external view returns (uint256 amountOut) {
        if (pool == address(0) || tokenIn == address(0) || amountIn == 0) revert BadAmount();
        return IConstantProductPool(pool).getAmountOut(amountIn, tokenIn);
    }

    function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut)
    {
        if (pool == address(0) || tokenIn == address(0) || to == address(0) || amountIn == 0 || minAmountOut == 0) {
            revert BadAmount();
        }
        IConstantProductPool p = IConstantProductPool(pool);
        address t0 = p.token0();
        address t1 = p.token1();
        if (tokenIn != t0 && tokenIn != t1) revert BadPool();

        if (!IERC20Minimal(tokenIn).transferFrom(msg.sender, address(this), amountIn)) revert TransferFailed();
        if (!IERC20Minimal(tokenIn).approve(pool, amountIn)) revert TransferFailed();

        amountOut = p.swapExactIn(tokenIn, amountIn, minAmountOut, to);
        if (amountOut < minAmountOut) revert InsufficientOut();
    }
}
