// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";

/**
 * LIQUIDITY POOL v2 — Protocol Plane (D-liquidity-01, ENGINE AMM-1..AMM-12). Written for this repository; no code copied.
 *
 * A constant-product (x*y=k) pool whose liquidity shares are a plain ERC-20 token, so a share can be held, sent and
 * approved like any token and a position is simply "this address's shares in this pool". Non-custodial by construction:
 *   · a provider deposits their own tokens and receives shares; the platform holds no key and no balance
 *   · no admin, no pause, no upgrade, no platform fee recipient; the swap fee is fixed at construction, 0 to 1000 bps
 *   · swap fees stay in the reserves, so they compound into every share (there is nothing separate to collect)
 *   · every state-changing entry is guarded against re-entry (AMM-9); `skim` and `sync` keep a donated balance from
 *     locking the pool (AMM-10)
 *
 * The swap, mint and burn entry points, the views and the Mint, Burn, Swap and Sync events keep the v1 pool's exact
 * signatures (`amm/ConstantProductPool.sol`), so every reader and calldata builder of v1 works on v2 unchanged.
 */
contract LiquidityPool {
    uint256 private constant FEE_DENOM = 10_000;
    uint256 private constant MINIMUM_LIQUIDITY = 1_000;
    /** The highest swap fee a pool may be created with: 10%. */
    uint16 public constant MAX_FEE_BPS = 1000;

    string public constant name = "Liquidity pool share";
    string public constant symbol = "LP";
    uint8 public constant decimals = 18;

    address public immutable token0;
    address public immutable token1;
    /** Swap fee in bps of the input amount (30 = 0.30%). Immutable. */
    uint16 public immutable feeBps;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;
    uint256 private unlocked = 1;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed sender, uint256 amount0, uint256 amount1, uint256 liquidity);
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, uint256 liquidity, address indexed to);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    error InvalidTokens();
    error InsufficientLiquidity();
    error InsufficientInput();
    error InsufficientOutput();
    error InvalidFee();
    error TransferFailed();
    error K();
    error Overflow();
    error Locked();
    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address tokenA, address tokenB, uint16 feeBps_) {
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) revert InvalidTokens();
        if (feeBps_ > MAX_FEE_BPS) revert InvalidFee();
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        feeBps = feeBps_;
    }

    // ── shares: a plain ERC-20 ────────────────────────────────────────────────

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        if (to == address(0)) revert ZeroAddress();
        if (balanceOf[from] < value) revert InsufficientBalance();
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function _mintShares(address to, uint256 value) private {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    // ── liquidity ─────────────────────────────────────────────────────────────

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    /**
     * Pulls both amounts from the caller and mints shares to `to`. The first deposit sets the price and locks 1,000
     * shares at the zero address for good (AMM-6); a later deposit mints the smaller of its two pro-rata amounts, so a
     * caller who wants only the pool's ratio pulled computes it first (the router does).
     */
    function mint(address to, uint256 amount0Desired, uint256 amount1Desired) external lock returns (uint256 liquidity) {
        if (amount0Desired == 0 || amount1Desired == 0) revert InsufficientInput();
        _pull(token0, msg.sender, amount0Desired);
        _pull(token1, msg.sender, amount1Desired);

        (uint112 r0, uint112 r1,) = getReserves();
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - uint256(r0);
        uint256 amount1 = balance1 - uint256(r1);

        if (totalSupply == 0) {
            liquidity = _sqrt(amount0 * amount1);
            if (liquidity <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            liquidity -= MINIMUM_LIQUIDITY;
            totalSupply = MINIMUM_LIQUIDITY;
            balanceOf[address(0)] = MINIMUM_LIQUIDITY;
            emit Transfer(address(0), address(0), MINIMUM_LIQUIDITY);
        } else {
            uint256 liq0 = (amount0 * totalSupply) / uint256(r0);
            uint256 liq1 = (amount1 * totalSupply) / uint256(r1);
            liquidity = liq0 < liq1 ? liq0 : liq1;
            if (liquidity == 0) revert InsufficientLiquidity();
        }
        _mintShares(to, liquidity);

        _update(balance0, balance1);
        emit Mint(msg.sender, amount0, amount1, liquidity);
    }

    /** Burns `liquidity` of the caller's shares and pays both tokens pro rata to `to` (AMM-5). */
    function burn(address to, uint256 liquidity) external lock returns (uint256 amount0, uint256 amount1) {
        if (liquidity == 0 || balanceOf[msg.sender] < liquidity) revert InsufficientLiquidity();
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));

        amount0 = (liquidity * balance0) / totalSupply;
        amount1 = (liquidity * balance1) / totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();

        balanceOf[msg.sender] -= liquidity;
        totalSupply -= liquidity;
        emit Transfer(msg.sender, address(0), liquidity);

        _push(token0, to, amount0);
        _push(token1, to, amount1);

        _update(IERC20Minimal(token0).balanceOf(address(this)), IERC20Minimal(token1).balanceOf(address(this)));
        emit Burn(msg.sender, amount0, amount1, liquidity, to);
    }

    /** Sends whatever the pool holds above its reserves to `to`, so a donation cannot distort the price (AMM-10). */
    function skim(address to) external lock {
        uint256 extra0 = IERC20Minimal(token0).balanceOf(address(this)) - uint256(reserve0);
        uint256 extra1 = IERC20Minimal(token1).balanceOf(address(this)) - uint256(reserve1);
        if (extra0 > 0) _push(token0, to, extra0);
        if (extra1 > 0) _push(token1, to, extra1);
    }

    /** Sets the reserves to what the pool holds (AMM-10). */
    function sync() external lock {
        _update(IERC20Minimal(token0).balanceOf(address(this)), IERC20Minimal(token1).balanceOf(address(this)));
    }

    // ── swaps: v1's exact surface ─────────────────────────────────────────────

    function swap(uint256 amount0Out, uint256 amount1Out, address to) external lock {
        _swap(amount0Out, amount1Out, to);
    }

    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)
        external
        lock
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert InsufficientInput();
        // Zero is not a bound: refuse before the pull so a callback token never sees the input.
        if (minAmountOut == 0) revert InsufficientOutput();
        (uint112 r0, uint112 r1,) = getReserves();
        bool zeroIn = tokenIn == token0;
        if (!zeroIn && tokenIn != token1) revert InvalidTokens();

        _pull(tokenIn, msg.sender, amountIn);
        amountOut = _getAmountOut(amountIn, zeroIn ? r0 : r1, zeroIn ? r1 : r0);
        if (amountOut < minAmountOut) revert InsufficientOutput();

        if (zeroIn) _swap(0, amountOut, to);
        else _swap(amountOut, 0, to);
    }

    function _swap(uint256 amount0Out, uint256 amount1Out, address to) private {
        if (amount0Out == 0 && amount1Out == 0) revert InsufficientOutput();
        if (amount0Out > 0 && amount1Out > 0) revert InsufficientOutput();
        (uint112 r0, uint112 r1,) = getReserves();
        if (amount0Out >= r0 || amount1Out >= r1) revert InsufficientLiquidity();

        if (amount0Out > 0) _push(token0, to, amount0Out);
        if (amount1Out > 0) _push(token1, to, amount1Out);

        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));

        uint256 amount0In = balance0 > uint256(r0) - amount0Out ? balance0 - (uint256(r0) - amount0Out) : 0;
        uint256 amount1In = balance1 > uint256(r1) - amount1Out ? balance1 - (uint256(r1) - amount1Out) : 0;
        if (amount0In == 0 && amount1In == 0) revert InsufficientInput();

        // (x - dx*fee) * (y - dy) >= x*y, the fee taken on the input side (AMM-2)
        {
            uint256 bal0Adj = (balance0 * FEE_DENOM) - (amount0In * uint256(feeBps));
            uint256 bal1Adj = (balance1 * FEE_DENOM) - (amount1In * uint256(feeBps));
            if (bal0Adj * bal1Adj < uint256(r0) * uint256(r1) * (FEE_DENOM * FEE_DENOM)) revert K();
        }

        _update(balance0, balance1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256) {
        (uint112 r0, uint112 r1,) = getReserves();
        bool zeroIn = tokenIn == token0;
        if (!zeroIn && tokenIn != token1) revert InvalidTokens();
        return _getAmountOut(amountIn, zeroIn ? r0 : r1, zeroIn ? r1 : r0);
    }

    function _getAmountOut(uint256 amountIn, uint112 reserveIn, uint112 reserveOut) private view returns (uint256) {
        if (amountIn == 0) revert InsufficientInput();
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * (FEE_DENOM - uint256(feeBps));
        return (amountInWithFee * uint256(reserveOut)) / ((uint256(reserveIn) * FEE_DENOM) + amountInWithFee);
    }

    function _update(uint256 balance0, uint256 balance1) private {
        if (balance0 > type(uint112).max || balance1 > type(uint112).max) revert Overflow();
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }

    function _pull(address token, address from, uint256 amount) private {
        if (!IERC20Minimal(token).transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) private {
        if (!IERC20Minimal(token).transfer(to, amount)) revert TransferFailed();
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
