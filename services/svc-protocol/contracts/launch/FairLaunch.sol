// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";

/**
 * FAIR LAUNCH — Protocol Plane (board S-G2 / `launch.launchpad`).
 *
 * Creator-configured presale: contributors send quote during a window, then
 * claim vested sale tokens (cliff + linear). No platform fee, no pause, no
 * whitelist, no revoke, no admin unlock. Creator cannot yank quote or sale
 * inventory before a public `finalize`.
 *
 * `minRaise` is required and must be > 0. If it is unmet at finalize, the sale
 * fails: contributors refund quote, creator reclaims unsold sale tokens.
 * A raise of 0 therefore cannot "succeed" and lock inventory.
 *
 * Residual (not this contract): staked allocation tiers need `stakeOf` and are
 * a later PR.
 */
contract FairLaunch {
    address public immutable creator;
    address public immutable saleToken;
    address public immutable quoteToken;
    uint256 public immutable saleAmount;
    uint256 public immutable raiseCap;
    uint256 public immutable minRaise;
    uint64 public immutable startTime;
    uint64 public immutable endTime;
    /// @dev 0 = no per-wallet cap (still bounded by `raiseCap`).
    uint256 public immutable perWalletCap;
    uint64 public immutable cliffSeconds;
    uint64 public immutable linearSeconds;

    uint256 public totalRaised;
    /// @dev Sale-token balance `fund` actually received. Claims use this, not the pull size.
    uint256 public saleCredited;
    uint64 public finalizedAt;
    bool public funded;
    bool public finalized;
    bool public success;
    bool public saleReclaimed;

    mapping(address => uint256) public contributed;
    mapping(address => uint256) public claimed;
    uint256 private entered;

    event Funded(uint256 amount);
    event Contributed(address indexed account, uint256 amount);
    event Finalized(bool success, uint256 totalRaised);
    event Claimed(address indexed account, uint256 amount);
    event Refunded(address indexed account, uint256 amount);
    event SaleReclaimed(uint256 amount);

    error BadConfig();
    error BadAmount();
    error NotFunded();
    error AlreadyFunded();
    error WindowClosed();
    error WindowOpen();
    error CapExceeded();
    error WalletCapExceeded();
    error AlreadyFinalized();
    error NotFinalized();
    error SaleFailed();
    error SaleSucceeded();
    error NothingToClaim();
    error NothingToRefund();
    error TransferFailed();
    error NotCreator();
    error AlreadyReclaimed();
    error Reentered();

    modifier nonReentrant() {
        if (entered != 0) revert Reentered();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(
        address saleToken_,
        address quoteToken_,
        uint256 saleAmount_,
        uint256 raiseCap_,
        uint256 minRaise_,
        uint64 startTime_,
        uint64 endTime_,
        uint256 perWalletCap_,
        uint64 cliffSeconds_,
        uint64 linearSeconds_
    ) {
        if (saleToken_ == address(0) || quoteToken_ == address(0) || saleToken_ == quoteToken_) revert BadConfig();
        if (saleAmount_ == 0 || raiseCap_ == 0) revert BadConfig();
        // minRaise > 0 so an empty book cannot finalize as success and strand sale tokens.
        if (minRaise_ == 0 || minRaise_ > raiseCap_) revert BadConfig();
        if (endTime_ <= startTime_ || endTime_ <= block.timestamp) revert BadConfig();
        if (perWalletCap_ != 0 && perWalletCap_ > raiseCap_) revert BadConfig();

        creator = msg.sender;
        saleToken = saleToken_;
        quoteToken = quoteToken_;
        saleAmount = saleAmount_;
        raiseCap = raiseCap_;
        minRaise = minRaise_;
        startTime = startTime_;
        endTime = endTime_;
        perWalletCap = perWalletCap_;
        cliffSeconds = cliffSeconds_;
        linearSeconds = linearSeconds_;
    }

    /**
     * Pull `saleAmount` of sale token and credit the balance actually received.
     * Anyone may fund before `endTime`. Once in, inventory cannot be withdrawn
     * except via fail-path `reclaimSale`. At or after `endTime`, contribute is
     * already closed, so a pull would sit at `totalRaised == 0` and
     * `reclaimSale` would pay it to the creator.
     */
    function fund() external nonReentrant {
        if (funded) revert AlreadyFunded();
        if (finalized) revert AlreadyFinalized();
        if (block.timestamp >= endTime) revert WindowClosed();
        uint256 received = _pull(saleToken, saleAmount);
        saleCredited = received;
        funded = true;
        emit Funded(received);
    }

    function contribute(uint256 amount) external nonReentrant {
        if (!funded) revert NotFunded();
        if (finalized) revert AlreadyFinalized();
        if (amount == 0) revert BadAmount();
        if (block.timestamp < startTime || block.timestamp >= endTime) revert WindowClosed();
        if (totalRaised >= raiseCap) revert CapExceeded();

        uint256 room = raiseCap - totalRaised;
        if (amount > room) revert CapExceeded();
        if (perWalletCap != 0) {
            uint256 used = contributed[msg.sender];
            if (amount > perWalletCap - used) revert WalletCapExceeded();
        }

        uint256 received = _pull(quoteToken, amount);
        if (received > room) revert CapExceeded();
        if (perWalletCap != 0 && received > perWalletCap - contributed[msg.sender]) revert WalletCapExceeded();

        totalRaised += received;
        contributed[msg.sender] += received;
        emit Contributed(msg.sender, received);
    }

    /// Pull `amount` and return the balance this contract actually gained.
    function _pull(address token, uint256 amount) private returns (uint256 received) {
        uint256 beforeBal = IERC20Minimal(token).balanceOf(address(this));
        if (!IERC20Minimal(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        received = IERC20Minimal(token).balanceOf(address(this)) - beforeBal;
        if (received == 0) revert BadAmount();
    }

    /**
     * Permissionless. After the window, or the moment the cap is filled.
     * Success pays quote to the creator in this tx; sale tokens stay for vesting.
     */
    function finalize() external nonReentrant {
        if (finalized) revert AlreadyFinalized();
        if (totalRaised < raiseCap && block.timestamp < endTime) revert WindowOpen();

        finalized = true;
        finalizedAt = uint64(block.timestamp);
        success = totalRaised >= minRaise;
        emit Finalized(success, totalRaised);

        if (success) {
            uint256 raised = totalRaised;
            if (raised > 0) {
                if (!IERC20Minimal(quoteToken).transfer(creator, raised)) revert TransferFailed();
            }
        }
    }

    function claim() external nonReentrant {
        if (!finalized) revert NotFinalized();
        if (!success) revert SaleFailed();

        uint256 out = claimable(msg.sender);
        if (out == 0) revert NothingToClaim();
        claimed[msg.sender] += out;
        if (!IERC20Minimal(saleToken).transfer(msg.sender, out)) revert TransferFailed();
        emit Claimed(msg.sender, out);
    }

    function refund() external nonReentrant {
        if (!finalized) revert NotFinalized();
        if (success) revert SaleSucceeded();

        uint256 amount = contributed[msg.sender];
        if (amount == 0) revert NothingToRefund();
        contributed[msg.sender] = 0;
        if (!IERC20Minimal(quoteToken).transfer(msg.sender, amount)) revert TransferFailed();
        emit Refunded(msg.sender, amount);
    }

    function reclaimSale() external nonReentrant {
        if (msg.sender != creator) revert NotCreator();
        if (!finalized) revert NotFinalized();
        if (success) revert SaleSucceeded();
        if (saleReclaimed) revert AlreadyReclaimed();
        saleReclaimed = true;
        uint256 amount = IERC20Minimal(saleToken).balanceOf(address(this));
        if (amount == 0) revert BadAmount();
        if (!IERC20Minimal(saleToken).transfer(creator, amount)) revert TransferFailed();
        emit SaleReclaimed(amount);
    }

    function allocationOf(address account) public view returns (uint256) {
        if (!success || totalRaised == 0) return 0;
        return (saleCredited * contributed[account]) / totalRaised;
    }

    function vestedOf(address account) public view returns (uint256) {
        uint256 alloc = allocationOf(account);
        if (alloc == 0 || !finalized) return 0;
        uint256 cliffEnd = uint256(finalizedAt) + uint256(cliffSeconds);
        if (block.timestamp < cliffEnd) return 0;
        if (linearSeconds == 0) return alloc;
        uint256 elapsed = block.timestamp - cliffEnd;
        if (elapsed >= uint256(linearSeconds)) return alloc;
        return (alloc * elapsed) / uint256(linearSeconds);
    }

    function claimable(address account) public view returns (uint256) {
        uint256 vested = vestedOf(account);
        uint256 already = claimed[account];
        return vested > already ? vested - already : 0;
    }
}
