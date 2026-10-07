// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";
import {LaunchLpLock} from "../trust/LaunchLpLock.sol";

interface ITokenFactory {
    struct TokenParams {
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        address recipient;
    }

    function createToken(bytes32 userSalt, TokenParams calldata params) external returns (address token);
}

interface IPoolFactory {
    function getPool(address tokenA, address tokenB, uint16 feeBps) external view returns (address);
    function createPool(address tokenA, address tokenB, uint16 feeBps) external returns (address pool);
}

interface IConstantProductPool {
    function token0() external view returns (address);
    function mint(address to, uint256 amount0Desired, uint256 amount1Desired) external returns (uint256 liquidity);
}

/**
 * MEME LAUNCH — one-click token + AMM pool + LP lock (S-G1 / `launch.meme-factory`).
 *
 * Composes contracts that already exist. Does not rebuild them.
 *   · `TokenFactory` / `PoolFactory` are constructor immutables (already deployed).
 *   · `LaunchLpLock` is created per launch with `new` (immutable unlockTime, no admin).
 *
 * Permissionless. No owner, no fee, no platform address. Keeps nothing.
 *
 * ConstantProductPool LP shares are internal accounting, not an ERC-20, so
 * `LaunchLpLock.lock` cannot pull them. Minting LP to the lock address IS the
 * lock: only the lock's address holds the shares, and `claim` still reverts
 * `LockedStill` until `unlockTime`. After that, `claim` burns those shares
 * and the pool sends the deposited token and quote to the beneficiary.
 */
contract MemeLaunch {
    address public immutable tokenFactory;
    address public immutable poolFactory;

    struct LaunchParams {
        /** `address(0)` → create via TokenFactory using the name/symbol fields. */
        address existingToken;
        string name;
        string symbol;
        uint8 decimals;
        uint256 totalSupply;
        address quoteToken;
        uint16 feeBps;
        uint256 tokenAmount;
        uint256 quoteAmount;
        uint64 unlockTime;
        bytes32 userSalt;
    }

    event Launched(
        address indexed token,
        address indexed pool,
        address indexed lpLock,
        address creator,
        uint256 liquidity,
        uint64 unlockTime
    );

    error ZeroAmount();
    error UnlockTime();
    error IdenticalTokens();
    error ZeroAddress();
    error TransferFailed();
    error InsufficientSupply();

    constructor(address tokenFactory_, address poolFactory_) {
        if (tokenFactory_ == address(0) || poolFactory_ == address(0)) revert ZeroAddress();
        tokenFactory = tokenFactory_;
        poolFactory = poolFactory_;
    }

    /**
     * Create (or take) a token, create the pool if missing, seed LP, park LP
     * at a fresh `LaunchLpLock` whose beneficiary is `msg.sender`.
     */
    function launch(LaunchParams calldata p)
        external
        returns (address token, address pool, address lpLock, uint256 liquidity)
    {
        if (p.tokenAmount == 0 || p.quoteAmount == 0) revert ZeroAmount();
        if (p.unlockTime <= block.timestamp) revert UnlockTime();
        if (p.quoteToken == address(0)) revert ZeroAddress();

        token = p.existingToken;
        if (token == address(0)) {
            token = ITokenFactory(tokenFactory).createToken(
                p.userSalt,
                ITokenFactory.TokenParams({
                    name: p.name,
                    symbol: p.symbol,
                    decimals: p.decimals,
                    totalSupply: p.totalSupply,
                    recipient: address(this)
                })
            );
            uint256 minted = IERC20Minimal(token).balanceOf(address(this));
            if (minted < p.tokenAmount) revert InsufficientSupply();
            uint256 leftover = minted - p.tokenAmount;
            if (leftover > 0) {
                if (!IERC20Minimal(token).transfer(msg.sender, leftover)) revert TransferFailed();
            }
        } else {
            if (!IERC20Minimal(token).transferFrom(msg.sender, address(this), p.tokenAmount)) revert TransferFailed();
        }

        if (token == p.quoteToken) revert IdenticalTokens();

        if (!IERC20Minimal(p.quoteToken).transferFrom(msg.sender, address(this), p.quoteAmount)) revert TransferFailed();

        pool = IPoolFactory(poolFactory).getPool(token, p.quoteToken, p.feeBps);
        if (pool == address(0)) {
            pool = IPoolFactory(poolFactory).createPool(token, p.quoteToken, p.feeBps);
        }

        lpLock = address(new LaunchLpLock(pool, msg.sender, p.unlockTime));

        if (!IERC20Minimal(token).approve(pool, p.tokenAmount)) revert TransferFailed();
        if (!IERC20Minimal(p.quoteToken).approve(pool, p.quoteAmount)) revert TransferFailed();

        address token0 = IConstantProductPool(pool).token0();
        uint256 amount0 = token == token0 ? p.tokenAmount : p.quoteAmount;
        uint256 amount1 = token == token0 ? p.quoteAmount : p.tokenAmount;

        liquidity = IConstantProductPool(pool).mint(lpLock, amount0, amount1);
        if (liquidity == 0) revert ZeroAmount();

        emit Launched(token, pool, lpLock, msg.sender, liquidity, p.unlockTime);
    }
}
