// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";

interface IPoolV2 {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function feeBps() external view returns (uint16);
    function getReserves() external view returns (uint112, uint112, uint32);
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external;
}

interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPermitToken {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

interface ISovereignPermit {
    function permit(
        address owner,
        address token,
        address spender,
        uint160 amount,
        uint48 expiration,
        uint48 nonce,
        uint256 sigDeadline,
        bytes calldata signature
    ) external;
    function transferFrom(address owner, address to, uint160 amount, address token) external;
}

/**
 * SOVEREIGN ROUTER V2 (D-swap-03, D-swap-intents-01, -02; ENGINE AMM-2, AMM-3, AMM-8, AMM-11, PRM-2/3).
 *
 * Swaps on the existing constant-product pools through their low-level `swap`, which checks K from balances, so the
 * pools stay as they are and the v1 router stays deployed and readable. What v2 adds:
 *
 * - a deadline on every state-changing entry (`Expired`; zero is never a deadline);
 * - exact input over a path of one or more pools, with a minimum for every hop (`HopBelowMin(hop)`) and for the total
 *   (`InsufficientOut`). The call is atomic: a hop under its minimum reverts the whole swap, so nothing moves;
 * - exact output over a path, paying no more than the stated maximum (`ExcessiveInput`);
 * - native input wrapped and native output unwrapped in the same transaction, unused native refunded;
 * - three ways to pull the input: the person's allowance to this router (approve, or the token's own EIP-2612 permit
 *   through `selfPermit`), the person's standing allowance in SovereignPermit (`standingPermit` sets it from a signature;
 *   a pull after its expiration reverts there), or native value.
 *
 * Holds nothing between calls (invariant `router.balance-zero-after-every-call`). No admin, no pause, no fee. Behaviour
 * follows the Uniswap v2 router as a study reference; the code is written here, nothing is copied. TEST deployments
 * only; `audited` stays false (the audit is external). Integrator fees on output (AMM-13) are not in this contract yet.
 */
contract SovereignRouterV2 {
    enum Pull {
        Allowance,
        Standing,
        Native
    }

    uint256 private constant FEE_DENOM = 10_000;

    IWrappedNative public immutable wrappedNative;
    ISovereignPermit public immutable sovereignPermit;
    uint256 private _locked = 1;

    error Expired();
    error BadPath();
    error BadAmount();
    error HopBelowMin(uint256 hop);
    error InsufficientOut();
    error ExcessiveInput();
    error InsufficientLiquidity();
    error TransferFailed();
    error NativeMismatch();
    error Reentrant();
    error ZeroAddress();

    constructor(address wrappedNative_, address sovereignPermit_) {
        if (wrappedNative_ == address(0) || sovereignPermit_ == address(0)) revert ZeroAddress();
        wrappedNative = IWrappedNative(wrappedNative_);
        sovereignPermit = ISovereignPermit(sovereignPermit_);
    }

    modifier lock() {
        if (_locked != 1) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier ensure(uint256 deadline) {
        if (deadline == 0 || block.timestamp > deadline) revert Expired();
        _;
    }

    receive() external payable {
        // Only the wrapped-native contract pays this router native value (on unwrap).
        if (msg.sender != address(wrappedNative)) revert NativeMismatch();
    }

    // ---------------------------------------------------------------- approvals by signature

    /**
     * Uses the caller's EIP-2612 signature on `token` naming this router as spender. When the allowance is already at
     * least `value` (the permit was submitted by someone else first) it does nothing, so a front-run cannot block the
     * swap; the token's own nonce makes a signature count once.
     */
    function selfPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) public {
        if (IERC20Minimal(token).allowance(msg.sender, address(this)) >= value) return;
        IPermitToken(token).permit(msg.sender, address(this), value, deadline, v, r, s);
    }

    /// Sets the caller's standing allowance for this router in SovereignPermit from the caller's signature.
    function standingPermit(
        address token,
        uint160 amount,
        uint48 expiration,
        uint48 nonce,
        uint256 sigDeadline,
        bytes calldata signature
    ) public {
        sovereignPermit.permit(msg.sender, token, address(this), amount, expiration, nonce, sigDeadline, signature);
    }

    /// Several of this router's calls in one transaction (a permit, then the swap). Native value is not taken here.
    function multicall(bytes[] calldata calls) external returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory out) = address(this).delegatecall(calls[i]);
            if (!ok) {
                assembly {
                    revert(add(out, 32), mload(out))
                }
            }
            results[i] = out;
        }
    }

    // ---------------------------------------------------------------- swaps

    /**
     * One swap along `path` (n + 1 tokens) through `pools` (n pools; pool i trades path[i] for path[i + 1]).
     * Exact input: `amount` is what the person pays, `limit` the least the last hop pays `to`, and `minOutPerHop[i]` the
     * least hop i pays. Exact output: `amount` is what `to` receives, `limit` the most the person pays, and
     * `minOutPerHop` is empty. `unwrapOut` pays the last token out as native; native input sends `amount` (exact input)
     * or `limit` (exact output) as value.
     */
    struct Swap {
        address[] path;
        address[] pools;
        uint256 amount;
        uint256 limit;
        uint256[] minOutPerHop;
        address to;
        uint256 deadline;
        Pull pull;
        bool unwrapOut;
    }

    function exactIn(Swap calldata p) external payable lock ensure(p.deadline) returns (uint256 amountOut) {
        uint256 hops = _checkSwap(p);
        if (p.minOutPerHop.length != hops) revert BadPath();
        _pullInput(p.path[0], p.pools[0], p.amount, p.amount, p.pull);

        uint256 hopIn = p.amount;
        for (uint256 i = 0; i < hops; i++) {
            uint256 hopOut = _hopOutFor(p.pools[i], p.path[i], hopIn);
            if (hopOut == 0 || hopOut < p.minOutPerHop[i]) revert HopBelowMin(i);
            _swapHop(p.pools[i], p.path[i], hopOut, _recipient(p, i));
            hopIn = hopOut;
        }
        amountOut = hopIn;
        if (amountOut < p.limit) revert InsufficientOut();
        if (p.unwrapOut) _sendNative(p.to, amountOut);
    }

    function exactOut(Swap calldata p) external payable lock ensure(p.deadline) returns (uint256 amountIn) {
        uint256 hops = _checkSwap(p);
        if (p.minOutPerHop.length != 0) revert BadPath();
        uint256[] memory amounts = _insFor(p.path, p.pools, p.amount);
        amountIn = amounts[0];
        if (amountIn > p.limit) revert ExcessiveInput();

        _pullInput(p.path[0], p.pools[0], amountIn, p.limit, p.pull);
        for (uint256 i = 0; i < hops; i++) _swapHop(p.pools[i], p.path[i], amounts[i + 1], _recipient(p, i));
        if (p.unwrapOut) _sendNative(p.to, p.amount);
        if (p.pull == Pull.Native && p.limit > amountIn) _sendNative(msg.sender, p.limit - amountIn);
    }

    // ---------------------------------------------------------------- reads

    /// The output of each hop for `amountIn` along the path, at the pools' current reserves.
    function quoteExactIn(address[] calldata path, address[] calldata pools, uint256 amountIn)
        external
        view
        returns (uint256[] memory outs)
    {
        if (pools.length == 0 || path.length != pools.length + 1) revert BadPath();
        _checkPath(path, pools);
        outs = new uint256[](pools.length);
        uint256 hopIn = amountIn;
        for (uint256 i = 0; i < pools.length; i++) {
            (uint256 rIn, uint256 rOut, uint256 fee) = _reserves(pools[i], path[i]);
            hopIn = _amountOut(hopIn, rIn, rOut, fee);
            outs[i] = hopIn;
        }
    }

    /// The input each hop needs for exactly `amountOut` at the end of the path; `ins[0]` is what the person pays.
    function quoteExactOut(address[] calldata path, address[] calldata pools, uint256 amountOut)
        external
        view
        returns (uint256[] memory ins)
    {
        if (pools.length == 0 || path.length != pools.length + 1) revert BadPath();
        _checkPath(path, pools);
        ins = _insFor(path, pools, amountOut);
    }

    // ---------------------------------------------------------------- internals

    function _checkSwap(Swap calldata p) private view returns (uint256 hops) {
        hops = p.pools.length;
        if (hops == 0 || p.path.length != hops + 1) revert BadPath();
        if (p.amount == 0 || p.limit == 0) revert BadAmount();
        if (p.to == address(0)) revert ZeroAddress();
        if (p.unwrapOut && (p.path[hops] != address(wrappedNative) || p.pull == Pull.Native)) revert BadPath();
        _checkPath(p.path, p.pools);
    }

    function _recipient(Swap calldata p, uint256 hop) private view returns (address) {
        if (hop + 1 < p.pools.length) return p.pools[hop + 1];
        return p.unwrapOut ? address(this) : p.to;
    }

    function _insFor(address[] calldata path, address[] calldata pools, uint256 amountOut)
        private
        view
        returns (uint256[] memory ins)
    {
        ins = new uint256[](pools.length + 1);
        ins[pools.length] = amountOut;
        for (uint256 i = pools.length; i > 0; i--) ins[i - 1] = _hopInFor(pools[i - 1], path[i - 1], ins[i]);
    }

    function _checkPath(address[] calldata path, address[] calldata pools) private view {
        for (uint256 i = 0; i < pools.length; i++) {
            address t0 = IPoolV2(pools[i]).token0();
            address t1 = IPoolV2(pools[i]).token1();
            bool matches = (path[i] == t0 && path[i + 1] == t1) || (path[i] == t1 && path[i + 1] == t0);
            if (!matches) revert BadPath();
        }
    }

    /// Moves the input into the first pool: from the caller's allowance, its standing allowance, or wrapped from value.
    function _pullInput(address token, address pool, uint256 amount, uint256 nativeExpected, Pull pull) private {
        if (pull == Pull.Native) {
            if (token != address(wrappedNative) || msg.value != nativeExpected) revert NativeMismatch();
            wrappedNative.deposit{value: amount}();
            if (!wrappedNative.transfer(pool, amount)) revert TransferFailed();
            return;
        }
        if (msg.value != 0) revert NativeMismatch();
        if (pull == Pull.Standing) {
            if (amount > type(uint160).max) revert BadAmount();
            sovereignPermit.transferFrom(msg.sender, pool, uint160(amount), token);
            return;
        }
        (bool ok, bytes memory out) =
            token.call(abi.encodeCall(IERC20Minimal.transferFrom, (msg.sender, pool, amount)));
        if (!ok || (out.length > 0 && !abi.decode(out, (bool)))) revert TransferFailed();
    }

    /// What `pool` pays for the input already sent to it: its balance of `tokenIn` above its recorded reserve.
    function _hopOutFor(address pool, address tokenIn, uint256 expectedIn) private view returns (uint256) {
        (uint256 rIn, uint256 rOut, uint256 fee) = _reserves(pool, tokenIn);
        uint256 received = IERC20Minimal(tokenIn).balanceOf(pool) - rIn;
        if (received < expectedIn) revert TransferFailed();
        return _amountOut(received, rIn, rOut, fee);
    }

    function _hopInFor(address pool, address tokenIn, uint256 out) private view returns (uint256) {
        (uint256 rIn, uint256 rOut, uint256 fee) = _reserves(pool, tokenIn);
        if (out >= rOut) revert InsufficientLiquidity();
        return (rIn * out * FEE_DENOM) / ((rOut - out) * (FEE_DENOM - fee)) + 1;
    }

    function _swapHop(address pool, address tokenIn, uint256 out, address recipient) private {
        if (tokenIn == IPoolV2(pool).token0()) IPoolV2(pool).swap(0, out, recipient);
        else IPoolV2(pool).swap(out, 0, recipient);
    }

    function _reserves(address pool, address tokenIn) private view returns (uint256 rIn, uint256 rOut, uint256 fee) {
        (uint112 r0, uint112 r1,) = IPoolV2(pool).getReserves();
        bool zeroIn = tokenIn == IPoolV2(pool).token0();
        (rIn, rOut) = zeroIn ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        fee = IPoolV2(pool).feeBps();
        if (rIn == 0 || rOut == 0) revert InsufficientLiquidity();
    }

    function _amountOut(uint256 amountIn, uint256 rIn, uint256 rOut, uint256 fee) private pure returns (uint256) {
        if (amountIn == 0) return 0;
        uint256 withFee = amountIn * (FEE_DENOM - fee);
        return (withFee * rOut) / (rIn * FEE_DENOM + withFee);
    }

    function _sendNative(address to, uint256 amount) private {
        if (address(this).balance < amount) wrappedNative.withdraw(amount - address(this).balance);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
