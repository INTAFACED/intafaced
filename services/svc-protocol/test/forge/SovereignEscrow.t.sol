// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SovereignEscrow} from "../../contracts/escrow/SovereignEscrow.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

interface ILockSeller {
    function onLockReenter() external;
}

/// Token whose `transferFrom` calls the seller before the pull is credited.
contract ReenteringLockToken {
    string public name = "Reenter";
    string public symbol = "RE";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public armed;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function arm() external {
        armed = true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        if (armed) {
            armed = false;
            ILockSeller(from).onLockReenter();
        }
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) private returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// Lock must finish the pull before the deal is Locked, and a callback during
/// that pull must not pay this deal or any other deal of the same token.
contract SovereignEscrowLockReentrancyTest {
    uint128 internal constant OTHER_AMOUNT = 1_000;
    uint128 internal constant ATTACK_AMOUNT = 400;

    SovereignEscrow internal escrow;
    ReenteringLockToken internal token;
    uint256 internal otherDeal;
    uint256 internal attackDeal;
    address internal otherBuyer;
    address internal attackBuyer;
    bool internal reentered;
    bool internal pullSawOpen;
    bool internal otherDealUntouched;
    bool internal anyPaySucceeded;

    function test_lock_reentrancy_cannot_pay_another_deal() public {
        escrow = new SovereignEscrow();
        token = new ReenteringLockToken();
        otherBuyer = address(0xB0B);
        attackBuyer = address(0xA77AC);

        token.mint(address(this), uint256(OTHER_AMOUNT) + uint256(ATTACK_AMOUNT));
        token.approve(address(escrow), type(uint256).max);

        otherDeal = _open(escrow, otherBuyer, address(token), OTHER_AMOUNT);
        escrow.lock(otherDeal);
        require(_status(escrow, otherDeal) == SovereignEscrow.Status.Locked, "other deal locked");
        require(token.balanceOf(address(escrow)) == OTHER_AMOUNT, "other deal funded");

        attackDeal = _open(escrow, attackBuyer, address(token), ATTACK_AMOUNT);
        token.arm();
        escrow.lock(attackDeal);

        require(reentered, "token did not call the seller");
        require(otherDealUntouched, "paid another deal during lock");
        require(!anyPaySucceeded, "reentrancy paid a deal");
        require(pullSawOpen, "deal locked before the pull finished");
        require(_status(escrow, otherDeal) == SovereignEscrow.Status.Locked, "other deal stays locked");
        require(_amount(escrow, otherDeal) == OTHER_AMOUNT, "other amount");
        require(_status(escrow, attackDeal) == SovereignEscrow.Status.Locked, "locked after pull");
        require(_amount(escrow, attackDeal) == ATTACK_AMOUNT, "attack amount");
        require(token.balanceOf(address(escrow)) == uint256(OTHER_AMOUNT) + uint256(ATTACK_AMOUNT), "escrow holds both");
        require(token.balanceOf(otherBuyer) == 0, "other buyer unpaid");
        require(token.balanceOf(attackBuyer) == 0, "attack buyer unpaid");
        require(token.balanceOf(address(this)) == 0, "seller pulled in full");
    }

    function test_release_and_refund_pay_only_that_deal() public {
        MockERC20 plain = new MockERC20();
        SovereignEscrow book = new SovereignEscrow();
        plain.mint(address(this), 1_500);
        plain.approve(address(book), type(uint256).max);
        address buyerA = address(0xA11CE);
        address buyerB = address(0xB0B);
        uint256 dealA = _open(book, buyerA, address(plain), 1_000);
        uint256 dealB = _open(book, buyerB, address(plain), 500);

        book.lock(dealA);
        book.lock(dealB);
        require(_status(book, dealA) == SovereignEscrow.Status.Locked, "deal A locked");
        require(_status(book, dealB) == SovereignEscrow.Status.Locked, "deal B locked");
        require(plain.balanceOf(address(book)) == 1_500, "both deals in escrow");

        book.release(dealA);
        require(plain.balanceOf(buyerA) == 1_000, "release pays the recorded amount");
        require(plain.balanceOf(buyerB) == 0, "other buyer stays unpaid");
        require(plain.balanceOf(address(book)) == 500, "other deal remains");
        require(_status(book, dealA) == SovereignEscrow.Status.Released, "A released");
        require(_amount(book, dealA) == 0, "A amount cleared");
        require(_status(book, dealB) == SovereignEscrow.Status.Locked, "B still locked");
        require(_amount(book, dealB) == 500, "B amount intact");

        book.refund(dealB);
        require(plain.balanceOf(address(this)) == 500, "refund pays the recorded amount");
        require(plain.balanceOf(address(book)) == 0, "escrow empty");
        require(plain.balanceOf(buyerA) == 1_000, "release stays put");
        require(_status(book, dealB) == SovereignEscrow.Status.Refunded, "B refunded");
        require(_amount(book, dealB) == 0, "B amount cleared");
    }

    /// Called by the token during `transferFrom`, before the pull is credited.
    function onLockReenter() external {
        require(msg.sender == address(token), "only token");
        reentered = true;
        (uint128 attackAmount, SovereignEscrow.Status attackStatus) = _peek(escrow, attackDeal);
        pullSawOpen = attackStatus == SovereignEscrow.Status.Open && attackAmount == ATTACK_AMOUNT;
        anyPaySucceeded = _tryRelease(otherDeal) || _tryRefund(otherDeal) || _tryRelease(attackDeal) || _tryRefund(attackDeal);
        (uint128 otherAmount, SovereignEscrow.Status otherStatus) = _peek(escrow, otherDeal);
        otherDealUntouched = otherStatus == SovereignEscrow.Status.Locked && otherAmount == OTHER_AMOUNT
            && token.balanceOf(address(escrow)) >= OTHER_AMOUNT && token.balanceOf(otherBuyer) == 0
            && token.balanceOf(attackBuyer) == 0 && token.balanceOf(address(this)) == ATTACK_AMOUNT;
    }

    function _tryRelease(uint256 dealId) internal returns (bool ok) {
        try escrow.release(dealId) {
            ok = true;
        } catch {}
    }

    function _tryRefund(uint256 dealId) internal returns (bool ok) {
        try escrow.refund(dealId) {
            ok = true;
        } catch {}
    }

    function _open(SovereignEscrow book, address buyer, address asset, uint128 amount) internal returns (uint256) {
        return book.open(
            buyer, asset, amount, address(0), address(0), 0, 3_600, SovereignEscrow.TimeoutDisposition.RefundSeller
        );
    }

    function _peek(SovereignEscrow book, uint256 dealId)
        internal
        view
        returns (uint128 amount, SovereignEscrow.Status status)
    {
        (,,, amount,,,,,, status,) = book.deals(dealId);
    }

    function _amount(SovereignEscrow book, uint256 dealId) internal view returns (uint128 amount) {
        (amount,) = _peek(book, dealId);
    }

    function _status(SovereignEscrow book, uint256 dealId) internal view returns (SovereignEscrow.Status status) {
        (, status) = _peek(book, dealId);
    }
}
