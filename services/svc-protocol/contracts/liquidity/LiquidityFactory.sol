// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LiquidityPool} from "./LiquidityPool.sol";

/**
 * LIQUIDITY FACTORY v2 — deterministic pool creation (D-liquidity-01, -03). Written for this repository; no code copied.
 *
 * Anyone may create a pool for a token pair and a fee from 0 to 1000 bps; one pool per (pair, fee). The CREATE2 salt is
 * keccak256(token0, token1, feeBps), so the address is known before the pool exists (`predictPoolAddress`). The views,
 * `createPool` and the PoolCreated event keep the v1 factory's exact signatures (`amm/PoolFactory.sol`), so the readers
 * of v1 read v2 unchanged. No admin, no allowlist, no platform fee recipient.
 */
contract LiquidityFactory {
    event PoolCreated(address indexed token0, address indexed token1, uint16 feeBps, address pool, uint256 index);

    mapping(address => mapping(address => mapping(uint16 => address))) public getPool;
    address[] public allPools;

    error IdenticalTokens();
    error ZeroAddress();
    error PoolExists();
    error FeeAboveCap();

    function allPoolsLength() external view returns (uint256) {
        return allPools.length;
    }

    function predictPoolAddress(address tokenA, address tokenB, uint16 feeBps) external view returns (address pool) {
        (address token0, address token1) = _sort(tokenA, tokenB);
        bytes32 salt = keccak256(abi.encodePacked(token0, token1, feeBps));
        bytes memory bytecode = abi.encodePacked(type(LiquidityPool).creationCode, abi.encode(token0, token1, feeBps));
        bytes32 hash = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(bytecode)));
        pool = address(uint160(uint256(hash)));
    }

    function createPool(address tokenA, address tokenB, uint16 feeBps) external returns (address pool) {
        (address token0, address token1) = _sort(tokenA, tokenB);
        if (feeBps > 1000) revert FeeAboveCap();
        if (getPool[token0][token1][feeBps] != address(0)) revert PoolExists();

        bytes32 salt = keccak256(abi.encodePacked(token0, token1, feeBps));
        pool = address(new LiquidityPool{salt: salt}(token0, token1, feeBps));
        getPool[token0][token1][feeBps] = pool;
        getPool[token1][token0][feeBps] = pool;
        allPools.push(pool);
        emit PoolCreated(token0, token1, feeBps, pool, allPools.length - 1);
    }

    function _sort(address tokenA, address tokenB) private pure returns (address token0, address token1) {
        if (tokenA == tokenB) revert IdenticalTokens();
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroAddress();
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }
}
