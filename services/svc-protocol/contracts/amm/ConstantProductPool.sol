// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./IERC20Minimal.sol";

/**
 * CONSTANT-PRODUCT AMM POOL — Protocol Plane (§17 / tracker protocol.amm).
 *
 * Uniswap-V2-class x*y=k pool. Non-custodial by construction:
 *   · liquidity providers deposit their own ERC-20s and receive LP shares
 *   · swaps pull tokens the caller already approved — the platform holds no key
 *   · no admin, no pause, no fee-to-platform special role beyond the fixed swap fee
 *   · fee is baked in at construction (bps), not tunable by any INTAFACED address
 *
 * This contract does not import, reference, or trust any platform service.
 * svc-protocol only builds calldata the user's smart account will sign.
 *
 * LP shares are internal accounting (not a full ERC-20) for v1 surface area;
 * `socket.amm-lp-token` can promote them later without changing the invariant.
 */
contract ConstantProductPool {
    uint256 private constant FEE_DENOM = 10_000;
    uint256 private constant MINIMUM_LIQUIDITY = 1_000;

    address public immutable token0;
    address public immutable token1;
    /** Swap fee in bps of input amount (e.g. 30 = 0.30%). Immutable. */
    uint16 public immutable feeBps;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

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
    error DeadlineMissing();
    error DeadlineExpired();
    error MaxInputMissing();
    error ExcessiveInput();

    constructor(address tokenA, address tokenB, uint16 feeBps_) {
        if (tokenA == address(0) || tokenB == address(0) || tokenA == tokenB) revert InvalidTokens();
        if (feeBps_ > 1000) revert InvalidFee(); // hard cap 10%
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        feeBps = feeBps_;
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    /**
     * First deposit seeds the pool; later deposits mint pro-rata LP.
     * Caller must have transferred tokens in first (or approve + we pull).
     * This variant pulls via transferFrom for a single atomic add.
     */
    function mint(address to, uint256 amount0Desired, uint256 amount1Desired)
        external
        returns (uint256 liquidity)
    {
        if (amount0Desired == 0 || amount1Desired == 0) revert InsufficientInput();
        (uint256 pulled0, uint256 pulled1) = _pullBoth(amount0Desired, amount1Desired);
        (uint112 r0, uint112 r1,) = getReserves();
        if (totalSupply == 0) {
            liquidity = _seed(to);
        } else {
            // Credit stays the limiting side. Surplus from this pull is returned
            // before reserves are stored, so it does not accrue to existing LPs.
            liquidity = _mintLater(to, uint256(r0), uint256(r1), pulled0, pulled1);
        }
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));
        _update(balance0, balance1);
        emit Mint(msg.sender, balance0 - uint256(r0), balance1 - uint256(r1), liquidity);
    }

    function _pullBoth(uint256 amount0Desired, uint256 amount1Desired) private returns (uint256 pulled0, uint256 pulled1) {
        uint256 bal0Before = IERC20Minimal(token0).balanceOf(address(this));
        _pull(token0, msg.sender, amount0Desired);
        pulled0 = IERC20Minimal(token0).balanceOf(address(this)) - bal0Before;
        uint256 bal1Before = IERC20Minimal(token1).balanceOf(address(this));
        _pull(token1, msg.sender, amount1Desired);
        pulled1 = IERC20Minimal(token1).balanceOf(address(this)) - bal1Before;
    }

    function _seed(address to) private returns (uint256 liquidity) {
        uint256 amount0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 amount1 = IERC20Minimal(token1).balanceOf(address(this));
        liquidity = _sqrt(amount0 * amount1);
        if (liquidity <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
        // Permanently lock minimum liquidity — classic V2 anti-inflation dust.
        totalSupply = liquidity;
        balanceOf[address(0)] = MINIMUM_LIQUIDITY;
        liquidity -= MINIMUM_LIQUIDITY;
        balanceOf[to] += liquidity;
    }

    function _mintLater(address to, uint256 reserve0_, uint256 reserve1_, uint256 pulled0, uint256 pulled1)
        private
        returns (uint256 liquidity)
    {
        liquidity = _liquidityForDeposit(reserve0_, reserve1_);
        _refundToken(token0, reserve0_, liquidity, pulled0);
        _refundToken(token1, reserve1_, liquidity, pulled1);
        totalSupply += liquidity;
        balanceOf[to] += liquidity;
    }

    function _liquidityForDeposit(uint256 reserve0_, uint256 reserve1_) private view returns (uint256 liquidity) {
        uint256 amount0 = IERC20Minimal(token0).balanceOf(address(this)) - reserve0_;
        uint256 amount1 = IERC20Minimal(token1).balanceOf(address(this)) - reserve1_;
        uint256 liq0 = (amount0 * totalSupply) / reserve0_;
        uint256 liq1 = (amount1 * totalSupply) / reserve1_;
        liquidity = liq0 < liq1 ? liq0 : liq1;
        if (liquidity == 0) revert InsufficientLiquidity();
    }

    /**
     * Refund the part of this pull that is above the tokens supporting `liquidity_`.
     * Tokens already in the pool, above reserve, are not this pull and stay put.
     */
    function _refundToken(address token, uint256 reserve_, uint256 liquidity_, uint256 pulled) private {
        uint256 used = _tokensForLiquidity(liquidity_, reserve_, totalSupply);
        uint256 amount = IERC20Minimal(token).balanceOf(address(this)) - reserve_;
        if (amount <= used) return;
        uint256 surplus = amount - used;
        if (surplus > pulled) surplus = pulled;
        if (surplus != 0) _push(token, msg.sender, surplus);
    }

    /// Smallest integer amount that still supports `liquidity_` against `reserve`.
    function _tokensForLiquidity(uint256 liquidity_, uint256 reserve, uint256 supply) private pure returns (uint256 used) {
        uint256 product = liquidity_ * reserve;
        used = product / supply;
        if (used * supply < product) used += 1;
    }

    function burn(address to, uint256 liquidity) external returns (uint256 amount0, uint256 amount1) {
        if (liquidity == 0 || balanceOf[msg.sender] < liquidity) revert InsufficientLiquidity();
        (uint112 r0, uint112 r1,) = getReserves();
        uint256 balance0 = IERC20Minimal(token0).balanceOf(address(this));
        uint256 balance1 = IERC20Minimal(token1).balanceOf(address(this));

        amount0 = (liquidity * balance0) / totalSupply;
        amount1 = (liquidity * balance1) / totalSupply;
        if (amount0 == 0 || amount1 == 0) revert InsufficientLiquidity();

        balanceOf[msg.sender] -= liquidity;
        totalSupply -= liquidity;

        _push(token0, to, amount0);
        _push(token1, to, amount1);

        balance0 = IERC20Minimal(token0).balanceOf(address(this));
        balance1 = IERC20Minimal(token1).balanceOf(address(this));
        _update(balance0, balance1);
        emit Burn(msg.sender, amount0, amount1, liquidity, to);
    }

    /**
     * Swap exact output. Tokens must already be transferred in (or use swapExactIn).
     *
     * `deadline` is the caller's last valid timestamp. Zero is missing.
     * `maxAmountIn` is the caller's ceiling on tokens paid. Zero is missing.
     * The shared body is `_swap` so `swapExactIn` can call it without an
     * external self-call.
     */
    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        uint256 deadline,
        uint256 maxAmountIn
    ) external {
        _requireDeadline(deadline);
        if (maxAmountIn == 0) revert MaxInputMissing();
        _swap(amount0Out, amount1Out, to, maxAmountIn);
    }

    /** Pull-and-swap convenience for a single exact-in hop. */
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to, uint256 deadline)
        external
        returns (uint256 amountOut)
    {
        _requireDeadline(deadline);
        if (amountIn == 0) revert InsufficientInput();
        (uint112 r0, uint112 r1,) = getReserves();
        bool zeroIn = tokenIn == token0;
        if (!zeroIn && tokenIn != token1) revert InvalidTokens();

        _pull(tokenIn, msg.sender, amountIn);
        amountOut = _getAmountOut(amountIn, zeroIn ? r0 : r1, zeroIn ? r1 : r0);
        if (amountOut < minAmountOut) revert InsufficientOutput();

        // The pull is the whole payment. Zero skips a second ceiling inside `_swap`.
        if (zeroIn) {
            _swap(0, amountOut, to, 0);
        } else {
            _swap(amountOut, 0, to, 0);
        }
    }

    /// Zero is a missing deadline. A timestamp before this block has already passed.
    function _requireDeadline(uint256 deadline) private view {
        if (deadline == 0) revert DeadlineMissing();
        if (deadline < block.timestamp) revert DeadlineExpired();
    }

    function _swap(uint256 amount0Out, uint256 amount1Out, address to, uint256 maxAmountIn) private {
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
        // `swap` rejects a zero ceiling before this. Exact-in passes zero: the pull is the payment.
        if (maxAmountIn != 0 && amount0In + amount1In > maxAmountIn) revert ExcessiveInput();

        // (x - dx*(1-fee)) * (y - dy) >= x*y  with fee on input
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
        uint256 numerator = amountInWithFee * uint256(reserveOut);
        uint256 denominator = (uint256(reserveIn) * FEE_DENOM) + amountInWithFee;
        return numerator / denominator;
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
