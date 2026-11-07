// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";
import {IPriceOracle} from "../oracle/IPriceOracle.sol";

interface IRecurringPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address to) external returns (uint256);
}

/**
 * RECURRING BUY VAULT (D-limit-dca-05, J-dex-protocol-11): a person buys a little of one token with another on a
 * schedule, from their own deposit, without signing each round.
 *
 *   · Keyless: no owner, no admin, no pause, no upgrade. The oracle is a constructor value.
 *   · `create` pulls every round's input at once (rounds × amount each round) from the maker into the plan. Nothing else
 *     can spend it: a round swaps exactly one round's input through the plan's own pool, and its output goes straight to
 *     the maker in that same transaction. `cancel` (the maker only) returns the unfilled remainder exactly and ends the
 *     plan.
 *   · The schedule is on chain: round n (from 0) is due at `start + n × interval`, by the chain's own block time. Round 1
 *     is due at once. A round fills only once it is due and only inside the plan's price band (when set), at no less
 *     than the oracle's price less the plan's slippage; a stale or disagreeing mark reverts, so nothing fills on a bad
 *     price.
 *   · A round outside its band waits. Once its retry window has passed with no fill, `skip` moves it to the next
 *     interval: the round keeps its money and its place, and every later round moves with it.
 *   · Anyone may call `fillRound` and `skip` (the platform keeper does): both only ever do what the plan says, so no
 *     signature is needed per round. Every round's fill emits `RoundFilled`, which is how a lost record is found again.
 */
contract RecurringBuyVault {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    struct Plan {
        address maker;
        address tokenIn;
        address tokenOut;
        address pool;
        uint256 amountPerRound;
        uint32 rounds;
        uint32 filled;
        uint64 interval;
        uint64 nextDue;
        uint64 retryWindow;
        uint16 slippageBps;
        bool open;
        /// The band, in tokenIn per one whole tokenOut, 1e18-scaled; zero for no bound.
        uint256 lowWad;
        uint256 highWad;
    }

    IPriceOracle public immutable oracle;
    mapping(bytes32 planId => Plan) private plans;
    mapping(address maker => uint256) public nonces;

    event PlanCreated(bytes32 indexed planId, address indexed maker, uint256 amountPerRound, uint32 rounds, uint64 firstDue);
    event RoundFilled(bytes32 indexed planId, uint32 round, uint256 amountIn, uint256 amountOut, uint256 priceWad);
    event RoundSkipped(bytes32 indexed planId, uint32 round, uint64 nextDue);
    event PlanCancelled(bytes32 indexed planId, uint256 refund);

    error BadConfig();
    error BadPlan();
    error NotDue();
    error OutsideBand();
    error WindowOpen();
    error NotMaker();
    error Closed();
    error BelowMinOut();
    error TransferFailed();
    error Reentered();

    uint256 private locked = 1;

    modifier nonReentrant() {
        if (locked != 1) revert Reentered();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(IPriceOracle oracle_) {
        if (address(oracle_) == address(0)) revert BadConfig();
        oracle = oracle_;
    }

    /// One whole tokenOut in tokenIn, 1e18-scaled, from the fail-closed oracle. A stale or disagreeing mark reverts.
    function price(address tokenIn, address tokenOut) public view returns (uint256) {
        (uint256 inMark,) = oracle.getMark(tokenIn);
        (uint256 outMark,) = oracle.getMark(tokenOut);
        return (outMark * WAD) / inMark;
    }

    /// A plan as it stands: its terms, how many rounds filled, when the next is due and whether it is open.
    function planOf(bytes32 planId) external view returns (Plan memory) {
        return plans[planId];
    }

    function planIdOf(address maker, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(maker, nonce));
    }

    /// What a person asks for when they start a plan.
    struct Terms {
        address tokenIn;
        address tokenOut;
        address pool;
        uint256 amountPerRound;
        uint32 rounds;
        uint64 interval;
        uint256 lowWad;
        uint256 highWad;
        uint64 retryWindow;
        uint16 slippageBps;
    }

    /// Starts a plan: every round's input moves from the maker into the plan now; round 1 is due at once.
    function create(Terms calldata t) external nonReentrant returns (bytes32 planId) {
        if (t.amountPerRound == 0 || t.rounds == 0 || t.interval == 0 || t.slippageBps >= BPS) revert BadPlan();
        if (t.retryWindow >= t.interval) revert BadPlan();
        if (t.highWad != 0 && t.lowWad > t.highWad) revert BadPlan();
        _checkPool(t.pool, t.tokenIn, t.tokenOut);
        planId = planIdOf(msg.sender, nonces[msg.sender]++);
        plans[planId] = Plan({
            maker: msg.sender,
            tokenIn: t.tokenIn,
            tokenOut: t.tokenOut,
            pool: t.pool,
            amountPerRound: t.amountPerRound,
            rounds: t.rounds,
            filled: 0,
            interval: t.interval,
            nextDue: uint64(block.timestamp),
            retryWindow: t.retryWindow,
            slippageBps: t.slippageBps,
            open: true,
            lowWad: t.lowWad,
            highWad: t.highWad
        });
        _pull(t.tokenIn, t.amountPerRound * t.rounds);
        emit PlanCreated(planId, msg.sender, t.amountPerRound, t.rounds, uint64(block.timestamp));
    }

    function _checkPool(address pool, address tokenIn, address tokenOut) private view {
        address t0 = IRecurringPool(pool).token0();
        address t1 = IRecurringPool(pool).token1();
        if (tokenIn == tokenOut || !((t0 == tokenIn && t1 == tokenOut) || (t0 == tokenOut && t1 == tokenIn))) revert BadPlan();
    }

    /// Pulls `total` from the caller; a token that pays less than it is told (a fee on transfer) is refused whole.
    function _pull(address token, uint256 total) private {
        uint256 before = IERC20Minimal(token).balanceOf(address(this));
        if (!IERC20Minimal(token).transferFrom(msg.sender, address(this), total)) revert TransferFailed();
        if (IERC20Minimal(token).balanceOf(address(this)) - before != total) revert TransferFailed();
    }

    /// The input the plan still holds: the rounds not yet filled.
    function remaining(bytes32 planId) public view returns (uint256) {
        Plan storage p = plans[planId];
        return p.open ? p.amountPerRound * (p.rounds - p.filled) : 0;
    }

    /// Whether the oracle price is inside the plan's band now (always, with no band).
    function inBand(bytes32 planId) public view returns (bool) {
        Plan storage p = plans[planId];
        uint256 now_ = price(p.tokenIn, p.tokenOut);
        return (p.lowWad == 0 || now_ >= p.lowWad) && (p.highWad == 0 || now_ <= p.highWad);
    }

    /// Fills the plan's due round: one round's input through its pool, the output straight to the maker.
    function fillRound(bytes32 planId) external nonReentrant returns (uint256 out) {
        Plan storage p = plans[planId];
        if (!p.open || p.filled >= p.rounds) revert Closed();
        if (block.timestamp < p.nextDue) revert NotDue();
        uint256 now_ = price(p.tokenIn, p.tokenOut);
        if ((p.lowWad != 0 && now_ < p.lowWad) || (p.highWad != 0 && now_ > p.highWad)) revert OutsideBand();
        // The least the round accepts: the oracle's price less the plan's slippage, in the output's own units.
        uint256 decIn = 10 ** IERC20Minimal(p.tokenIn).decimals();
        uint256 decOut = 10 ** IERC20Minimal(p.tokenOut).decimals();
        uint256 expected = (p.amountPerRound * WAD * decOut) / (now_ * decIn);
        uint256 floor = (expected * (BPS - p.slippageBps)) / BPS;
        if (floor == 0) floor = 1;

        uint32 round = p.filled;
        p.filled = round + 1;
        p.nextDue = p.nextDue + p.interval;
        if (p.filled == p.rounds) p.open = false;

        uint256 before = IERC20Minimal(p.tokenOut).balanceOf(p.maker);
        if (!IERC20Minimal(p.tokenIn).approve(p.pool, p.amountPerRound)) revert TransferFailed();
        IRecurringPool(p.pool).swapExactIn(p.tokenIn, p.amountPerRound, floor, p.maker);
        if (!IERC20Minimal(p.tokenIn).approve(p.pool, 0)) revert TransferFailed();
        out = IERC20Minimal(p.tokenOut).balanceOf(p.maker) - before;
        if (out < floor) revert BelowMinOut();
        emit RoundFilled(planId, round, p.amountPerRound, out, now_);
    }

    /// A due round that stayed unfilled past its retry window moves to the next interval, with every later round.
    function skip(bytes32 planId) external {
        Plan storage p = plans[planId];
        if (!p.open || p.filled >= p.rounds) revert Closed();
        if (block.timestamp <= uint256(p.nextDue) + p.retryWindow) revert WindowOpen();
        p.nextDue = p.nextDue + p.interval;
        emit RoundSkipped(planId, p.filled, p.nextDue);
    }

    /// The maker ends the plan; the unfilled remainder goes back to the maker exactly.
    function cancel(bytes32 planId) external nonReentrant returns (uint256 refund) {
        Plan storage p = plans[planId];
        if (p.maker != msg.sender) revert NotMaker();
        if (!p.open) revert Closed();
        refund = p.amountPerRound * (p.rounds - p.filled);
        p.open = false;
        if (!IERC20Minimal(p.tokenIn).transfer(p.maker, refund)) revert TransferFailed();
        emit PlanCancelled(planId, refund);
    }
}
