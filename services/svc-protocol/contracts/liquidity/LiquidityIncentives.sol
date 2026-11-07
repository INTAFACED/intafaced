// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";

/**
 * LIQUIDITY INCENTIVES — on-chain liquidity mining (D-liquidity-09, J-dex-protocol-13 #8). Written for this repository;
 * no code copied.
 *
 * An incentivizer announces a reward for one pool's shares (an amount of a reward token over a number of blocks, and who
 * gets back what is not paid), funds it from its own wallet, and starts it. While it runs, every block's reward is split
 * pro rata across the pool shares staked in it; a staker who leaves stops accruing at once and keeps what it earned.
 * An incentive that is not funded cannot start. Nothing here is the platform's: no admin, no fee, no pause, and the
 * contract only ever holds the funded rewards and the staked shares, each paid back to whom it belongs.
 */
contract LiquidityIncentives {
    uint256 private constant ACC = 1e36;

    struct Incentive {
        address pool;
        address rewardToken;
        address incentivizer;
        address refundee;
        uint256 total;
        uint64 blocks;
        bool funded;
        uint64 startBlock;
        uint64 endBlock;
        uint64 lastBlock;
        uint256 staked;
        uint256 accPerShare;
        uint256 paid;
        uint256 undistributed;
        bool refunded;
    }

    Incentive[] private incentives;
    mapping(uint256 => mapping(address => uint256)) public stakeOf;
    mapping(uint256 => mapping(address => uint256)) private debtOf;
    mapping(uint256 => mapping(address => uint256)) public owed;
    uint256 private unlocked = 1;

    event Created(uint256 indexed id, address indexed pool, address rewardToken, uint256 total, uint64 blocks, address refundee);
    event Funded(uint256 indexed id, uint256 total);
    event Started(uint256 indexed id, uint64 startBlock, uint64 endBlock);
    event Staked(uint256 indexed id, address indexed account, uint256 shares);
    event Unstaked(uint256 indexed id, address indexed account, uint256 shares);
    event Claimed(uint256 indexed id, address indexed account, uint256 reward);
    event Refunded(uint256 indexed id, address indexed refundee, uint256 amount);

    error BadConfig();
    error NotIncentivizer();
    error AlreadyFunded();
    error NotFunded();
    error AlreadyStarted();
    error Ended();
    error NotEnded();
    error BadAmount();
    error TransferFailed();
    error Locked();

    modifier lock() {
        if (unlocked != 1) revert Locked();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    function count() external view returns (uint256) {
        return incentives.length;
    }

    function get(uint256 id) external view returns (Incentive memory) {
        return incentives[id];
    }

    /** Announces an incentive; it moves nothing until funded. */
    function create(address pool, address rewardToken, uint256 total, uint64 blocks, address refundee) external returns (uint256 id) {
        if (pool == address(0) || rewardToken == address(0) || refundee == address(0) || total == 0 || blocks == 0) revert BadConfig();
        id = incentives.length;
        Incentive storage i = incentives.push();
        i.pool = pool;
        i.rewardToken = rewardToken;
        i.incentivizer = msg.sender;
        i.refundee = refundee;
        i.total = total;
        i.blocks = blocks;
        emit Created(id, pool, rewardToken, total, blocks, refundee);
    }

    /** The incentivizer pays the whole reward in, from its own wallet. */
    function fund(uint256 id) external lock {
        Incentive storage i = incentives[id];
        if (msg.sender != i.incentivizer) revert NotIncentivizer();
        if (i.funded) revert AlreadyFunded();
        i.funded = true;
        _pull(i.rewardToken, msg.sender, i.total);
        emit Funded(id, i.total);
    }

    /** Starts the period now. An incentive that is not funded cannot start. */
    function start(uint256 id) external {
        Incentive storage i = incentives[id];
        if (msg.sender != i.incentivizer) revert NotIncentivizer();
        if (!i.funded) revert NotFunded();
        if (i.startBlock != 0) revert AlreadyStarted();
        i.startBlock = uint64(block.number);
        i.endBlock = uint64(block.number) + i.blocks;
        i.lastBlock = uint64(block.number);
        emit Started(id, i.startBlock, i.endBlock);
    }

    /** Stakes pool shares (approved to this contract). Staking before the start is allowed; nothing accrues until then. */
    function stake(uint256 id, uint256 shares) external lock {
        Incentive storage i = incentives[id];
        if (shares == 0) revert BadAmount();
        if (i.endBlock != 0 && block.number >= i.endBlock) revert Ended();
        _settle(id, i, msg.sender);
        _pull(i.pool, msg.sender, shares);
        stakeOf[id][msg.sender] += shares;
        i.staked += shares;
        debtOf[id][msg.sender] = (stakeOf[id][msg.sender] * i.accPerShare) / ACC;
        emit Staked(id, msg.sender, shares);
    }

    /** Takes all staked shares back. Accrual stops at this block; what was earned stays owed. */
    function unstake(uint256 id) external lock {
        Incentive storage i = incentives[id];
        uint256 shares = stakeOf[id][msg.sender];
        if (shares == 0) revert BadAmount();
        _settle(id, i, msg.sender);
        stakeOf[id][msg.sender] = 0;
        debtOf[id][msg.sender] = 0;
        i.staked -= shares;
        _push(i.pool, msg.sender, shares);
        emit Unstaked(id, msg.sender, shares);
    }

    /** Pays what the caller has earned so far. */
    function claim(uint256 id) external lock returns (uint256 reward) {
        Incentive storage i = incentives[id];
        _settle(id, i, msg.sender);
        reward = owed[id][msg.sender];
        if (reward == 0) revert BadAmount();
        owed[id][msg.sender] = 0;
        i.paid += reward;
        _push(i.rewardToken, msg.sender, reward);
        emit Claimed(id, msg.sender, reward);
    }

    /** After the period, the refundee gets back what was never earned (blocks in which nothing was staked). */
    function refund(uint256 id) external lock returns (uint256 amount) {
        Incentive storage i = incentives[id];
        if (i.endBlock == 0 || block.number < i.endBlock) revert NotEnded();
        if (i.refunded) revert BadAmount();
        _accrue(i);
        i.refunded = true;
        amount = i.undistributed;
        if (amount > 0) _push(i.rewardToken, i.refundee, amount);
        emit Refunded(id, i.refundee, amount);
    }

    /** What `account` has earned and not been paid, as of this block. */
    function pending(uint256 id, address account) external view returns (uint256) {
        Incentive storage i = incentives[id];
        uint256 acc = i.accPerShare;
        (uint256 reward,) = _due(i);
        if (i.staked > 0) acc += (reward * ACC) / i.staked;
        return owed[id][account] + (stakeOf[id][account] * acc) / ACC - debtOf[id][account];
    }

    /** The reward for the blocks since the last accrual, within the period, and the block accrual reaches. */
    function _due(Incentive storage i) private view returns (uint256 reward, uint64 until) {
        if (i.startBlock == 0) return (0, i.lastBlock);
        until = uint64(block.number < i.endBlock ? block.number : i.endBlock);
        if (until <= i.lastBlock) return (0, i.lastBlock);
        reward = (i.total * (until - i.lastBlock)) / i.blocks;
    }

    function _accrue(Incentive storage i) private {
        (uint256 reward, uint64 until) = _due(i);
        if (reward == 0 && until == i.lastBlock) return;
        if (i.staked == 0) i.undistributed += reward;
        else i.accPerShare += (reward * ACC) / i.staked;
        i.lastBlock = until;
    }

    function _settle(uint256 id, Incentive storage i, address account) private {
        _accrue(i);
        uint256 earned = (stakeOf[id][account] * i.accPerShare) / ACC - debtOf[id][account];
        if (earned > 0) owed[id][account] += earned;
        debtOf[id][account] = (stakeOf[id][account] * i.accPerShare) / ACC;
    }

    function _pull(address token, address from, uint256 amount) private {
        if (!IERC20Minimal(token).transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address token, address to, uint256 amount) private {
        if (!IERC20Minimal(token).transfer(to, amount)) revert TransferFailed();
    }
}
