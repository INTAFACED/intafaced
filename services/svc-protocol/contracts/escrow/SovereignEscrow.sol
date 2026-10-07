// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "../amm/IERC20Minimal.sol";

/**
 * SOVEREIGN P2P ESCROW — Protocol Plane (board S-A3 / `protocol.escrow`).
 *
 * THIS IS NOT the custodial P2P product in svc-p2p. That one holds value in the
 * ledger; a human moderator adjudicates disputes; the timer never disposes of
 * funds (`docs/adr/2026-08-04-p2p-escrow-and-dispute-law.md`).
 *
 * Here the CONTRACT holds the ERC-20. The platform has no role, no pause, no
 * guardian key. Dispute timeout executes a disposition the parties agreed at
 * open time — a keeper may call it, anyone may call it, and it cannot invent a
 * third outcome.
 *
 * Lifecycle: open → lock → { release | refund | dispute → (arbiter | timeout) }.
 * Every locked deal has an exit. That is the no-stranded-funds bar.
 */
contract SovereignEscrow {
    enum Status {
        None,
        Open, // terms fixed, no tokens yet
        Locked, // seller funds held
        Disputed,
        Released,
        Refunded
    }

    /** What a keeper executes after `disputeDeadline` if no arbiter ruled. */
    enum TimeoutDisposition {
        RefundSeller,
        ReleaseBuyer
    }

    struct Deal {
        address seller;
        address buyer;
        address token;
        /** Open: the pull. Locked: tokens that arrived. Terminal paths zero it. */
        uint128 amount;
        /** Optional. address(0) = no human arbiter; only timeout settles disputes. */
        address arbiter;
        /** Optional fee on release; address(0) or 0 bps = no fee. */
        address feeRecipient;
        uint16 feeBps;
        uint32 disputeWindow; // seconds after dispute before timeout is live
        uint64 disputeDeadline; // 0 until disputed
        Status status;
        TimeoutDisposition timeoutDisposition;
    }

    uint256 public nextDealId = 1;
    mapping(uint256 dealId => Deal) public deals;

    event DealOpened(
        uint256 indexed dealId,
        address indexed seller,
        address indexed buyer,
        address token,
        uint128 amount,
        address arbiter,
        TimeoutDisposition timeoutDisposition,
        uint32 disputeWindow
    );
    event DealLocked(uint256 indexed dealId, uint128 amount);
    event DealReleased(uint256 indexed dealId, address indexed buyer, uint128 net, uint128 fee);
    event DealRefunded(uint256 indexed dealId, address indexed seller, uint128 amount);
    event DealDisputed(uint256 indexed dealId, address indexed by, uint64 deadline);
    event DealArbiterResolved(uint256 indexed dealId, address indexed arbiter, bool releaseToBuyer);
    event DealTimeoutSettled(uint256 indexed dealId, TimeoutDisposition disposition);

    error BadParties();
    error BadAmount();
    error BadFee();
    error BadWindow();
    error BadStatus();
    error NotSeller();
    error NotParty();
    error NotArbiter();
    error TransferInFailed();
    error TransferOutFailed();
    error DeadlineNotReached();
    error NoArbiter();
    error PullInProgress();

    /// Token currently inside `lock`'s `transferFrom`. Payouts of this token wait
    /// until that pull has finished, so a callback cannot spend another deal.
    mapping(address token => bool pulling) private tokenPull;

    /**
     * @param disputeWindow Seconds after dispute before anyone may `settleTimeout`.
     *        Must be > 0 so "disputed forever" is unrepresentable once disputed.
     */
    function open(
        address buyer,
        address token,
        uint128 amount,
        address arbiter,
        address feeRecipient,
        uint16 feeBps,
        uint32 disputeWindow,
        TimeoutDisposition timeoutDisposition
    ) external returns (uint256 dealId) {
        if (buyer == address(0) || buyer == msg.sender) revert BadParties();
        if (token == address(0) || amount == 0) revert BadAmount();
        if (feeBps > 10_000) revert BadFee();
        if (feeBps > 0 && feeRecipient == address(0)) revert BadFee();
        if (disputeWindow == 0) revert BadWindow();

        dealId = nextDealId++;
        deals[dealId] = Deal({
            seller: msg.sender,
            buyer: buyer,
            token: token,
            amount: amount,
            arbiter: arbiter,
            feeRecipient: feeRecipient,
            feeBps: feeBps,
            disputeWindow: disputeWindow,
            disputeDeadline: 0,
            status: Status.Open,
            timeoutDisposition: timeoutDisposition
        });

        emit DealOpened(dealId, msg.sender, buyer, token, amount, arbiter, timeoutDisposition, disputeWindow);
    }

    /**
     * Seller pulls the open amount. The deal is credited with the tokens that
     * arrived, so a fee-on-transfer token does not book the pre-fee pull.
     */
    function lock(uint256 dealId) external {
        Deal storage d = deals[dealId];
        if (d.status != Status.Open) revert BadStatus();
        if (msg.sender != d.seller) revert NotSeller();

        address token = d.token;
        uint128 amount = d.amount;
        if (tokenPull[token]) revert PullInProgress();
        tokenPull[token] = true;
        uint256 beforeBal = IERC20Minimal(token).balanceOf(address(this));
        bool ok = IERC20Minimal(token).transferFrom(msg.sender, address(this), amount);
        uint256 afterBal = IERC20Minimal(token).balanceOf(address(this));
        tokenPull[token] = false;
        if (!ok) revert TransferInFailed();
        if (d.status != Status.Open) revert BadStatus();

        uint256 received = afterBal > beforeBal ? afterBal - beforeBal : 0;
        if (received == 0 || received > type(uint128).max) revert TransferInFailed();

        d.amount = uint128(received);
        d.status = Status.Locked;
        emit DealLocked(dealId, uint128(received));
    }

    /** Seller releases to buyer (classic "fiat received" path). Only while Locked. */
    function release(uint256 dealId) external {
        Deal storage d = deals[dealId];
        if (d.status != Status.Locked) revert BadStatus();
        if (msg.sender != d.seller) revert NotSeller();
        _release(dealId, d);
    }

    /** Seller refunds self before any dispute. Only while Locked. */
    function refund(uint256 dealId) external {
        Deal storage d = deals[dealId];
        if (d.status != Status.Locked) revert BadStatus();
        if (msg.sender != d.seller) revert NotSeller();
        _refund(dealId, d);
    }

    /** Either party opens a dispute. Starts the timeout clock. */
    function dispute(uint256 dealId) external {
        Deal storage d = deals[dealId];
        if (d.status != Status.Locked) revert BadStatus();
        if (msg.sender != d.seller && msg.sender != d.buyer) revert NotParty();

        d.status = Status.Disputed;
        d.disputeDeadline = uint64(block.timestamp + d.disputeWindow);
        emit DealDisputed(dealId, msg.sender, d.disputeDeadline);
    }

    /** User-elected arbiter only — never a platform role. */
    function arbiterResolve(uint256 dealId, bool releaseToBuyer) external {
        Deal storage d = deals[dealId];
        if (d.status != Status.Disputed) revert BadStatus();
        if (d.arbiter == address(0)) revert NoArbiter();
        if (msg.sender != d.arbiter) revert NotArbiter();

        emit DealArbiterResolved(dealId, msg.sender, releaseToBuyer);
        if (releaseToBuyer) _release(dealId, d);
        else _refund(dealId, d);
    }

    /**
     * Keeper-safe timeout. Anyone may call after `disputeDeadline`.
     * Executes the immutable disposition chosen at open — no invention.
     */
    function settleTimeout(uint256 dealId) external {
        Deal storage d = deals[dealId];
        if (d.status != Status.Disputed) revert BadStatus();
        if (block.timestamp < d.disputeDeadline) revert DeadlineNotReached();

        emit DealTimeoutSettled(dealId, d.timeoutDisposition);
        if (d.timeoutDisposition == TimeoutDisposition.ReleaseBuyer) _release(dealId, d);
        else _refund(dealId, d);
    }

    function _release(uint256 dealId, Deal storage d) private {
        if (tokenPull[d.token]) revert PullInProgress();
        uint128 amount = d.amount;
        uint128 fee = d.feeBps == 0 ? 0 : uint128((uint256(amount) * d.feeBps) / 10_000);
        uint128 net = amount - fee;
        address token = d.token;
        d.status = Status.Released;
        d.amount = 0;

        uint256 beforeBal = IERC20Minimal(token).balanceOf(address(this));
        if (fee > 0) {
            if (!IERC20Minimal(token).transfer(d.feeRecipient, fee)) revert TransferOutFailed();
        }
        if (!IERC20Minimal(token).transfer(d.buyer, net)) revert TransferOutFailed();
        _boundSpend(token, beforeBal, amount);
        emit DealReleased(dealId, d.buyer, net, fee);
    }

    function _refund(uint256 dealId, Deal storage d) private {
        if (tokenPull[d.token]) revert PullInProgress();
        uint128 amount = d.amount;
        address token = d.token;
        d.status = Status.Refunded;
        d.amount = 0;
        uint256 beforeBal = IERC20Minimal(token).balanceOf(address(this));
        if (!IERC20Minimal(token).transfer(d.seller, amount)) revert TransferOutFailed();
        _boundSpend(token, beforeBal, amount);
        emit DealRefunded(dealId, d.seller, amount);
    }

    /// This deal can reduce the pooled balance by at most the tokens it was credited.
    function _boundSpend(address token, uint256 beforeBal, uint256 credit) private view {
        uint256 afterBal = IERC20Minimal(token).balanceOf(address(this));
        if (afterBal > beforeBal || beforeBal - afterBal > credit) revert TransferOutFailed();
    }
}
