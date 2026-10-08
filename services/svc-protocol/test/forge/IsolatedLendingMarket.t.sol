// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../../contracts/oracle/IPriceOracle.sol";
import {IsolatedLendingMarket} from "../../contracts/lending/IsolatedLendingMarket.sol";
import {InFlightBorrower, ReenteringBorrowToken} from "../../contracts/lending/test/LendingAdversary.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256 newTimestamp) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// Equal marks. Health is collateral versus debt, not a price disagreement.
contract FixedMarkOracle {
    function getMark(address) external view returns (uint256 priceWad, uint64 updatedAt) {
        return (1e18, uint64(block.timestamp));
    }
}

/// A borrow opened after the index has compounded on an empty share book owes the cash received.
contract IsolatedLendingMarketForgeTest {
    uint256 private constant WAD = 1e18;
    uint256 private constant BORROW = 1_000 ether;

    function test_borrow_after_compounded_index_with_zero_shares_owes_cash_received() public {
        MockERC20 collateral = new MockERC20();
        MockERC20 borrowToken = new MockERC20();
        FixedMarkOracle oracle = new FixedMarkOracle();

        IsolatedLendingMarket market = new IsolatedLendingMarket(
            IsolatedLendingMarket.MarketConfig({
                collateralToken: address(collateral),
                borrowToken: address(borrowToken),
                oracle: address(oracle),
                collateralAssetForOracle: address(collateral),
                borrowAssetForOracle: address(borrowToken),
                maxLtvBps: 5_000,
                liquidationThresholdBps: 8_000,
                liquidationBonusBps: 500,
                closeFactorBps: 5_000,
                reserveFactorBps: 0,
                baseRateBps: 10_000,
                slope1Bps: 0,
                slope2Bps: 0,
                kinkBps: 8_000
            })
        );

        address lp = address(0x1111);
        address first = address(0xA11CE);
        address next = address(0xB0B);

        borrowToken.mint(lp, 1_000_000 ether);
        vm.prank(lp);
        borrowToken.approve(address(market), type(uint256).max);
        vm.prank(lp);
        market.supplyLiquidity(1_000_000 ether);

        collateral.mint(first, 100_000 ether);
        vm.prank(first);
        collateral.approve(address(market), type(uint256).max);
        vm.prank(first);
        market.depositCollateral(100_000 ether);
        vm.prank(first);
        market.borrow(BORROW);
        require(market.debtOf(first) == BORROW, "index at WAD is 1:1");

        // One year at 100% APR doubles the index. A full repay then leaves that index with zero shares.
        vm.warp(block.timestamp + 365 days);
        borrowToken.mint(first, BORROW);
        vm.prank(first);
        borrowToken.approve(address(market), type(uint256).max);
        vm.prank(first);
        market.repay(type(uint256).max);

        require(market.totalDebtShares() == 0, "share book empty");
        require(market.borrowIndex() == 2 * WAD, "index compounded above WAD");

        collateral.mint(next, 100_000 ether);
        vm.prank(next);
        collateral.approve(address(market), type(uint256).max);
        vm.prank(next);
        market.depositCollateral(100_000 ether);

        uint256 beforeBal = borrowToken.balanceOf(next);
        vm.prank(next);
        market.borrow(BORROW);
        require(borrowToken.balanceOf(next) - beforeBal == BORROW, "received nominal cash");
        require(market.debtOf(next) == BORROW, "owes the cash received");
    }
}

/// Oracle the market will accept. A zero mark is a value it can return.
contract SettableMarkOracle is IPriceOracle {
    mapping(address => uint256) public priceWadOf;

    function set(address asset, uint256 priceWad) external {
        priceWadOf[asset] = priceWad;
    }

    function getMark(address asset) external view returns (uint256 priceWad, uint64 updatedAt) {
        priceWad = priceWadOf[asset];
        updatedAt = 1;
    }
}

/// L987: a zero mark is not a price. Debt is not valued at nothing, and liquidation does not divide by it.
contract IsolatedLendingZeroMarkTest {
    uint256 internal constant WAD = 1e18;
    bytes4 internal constant PANIC = 0x4e487b71;

    struct Book {
        MockERC20 col;
        MockERC20 bor;
        SettableMarkOracle oracle;
        IsolatedLendingMarket market;
    }

    function _book() internal returns (Book memory b) {
        b.col = new MockERC20();
        b.bor = new MockERC20();
        b.oracle = new SettableMarkOracle();
        b.oracle.set(address(b.col), 100 * WAD);
        b.oracle.set(address(b.bor), 100 * WAD);
        b.market = new IsolatedLendingMarket(
            IsolatedLendingMarket.MarketConfig({
                collateralToken: address(b.col),
                borrowToken: address(b.bor),
                oracle: address(b.oracle),
                collateralAssetForOracle: address(b.col),
                borrowAssetForOracle: address(b.bor),
                maxLtvBps: 5000,
                liquidationThresholdBps: 8000,
                liquidationBonusBps: 500,
                closeFactorBps: 5000,
                reserveFactorBps: 1000,
                baseRateBps: 200,
                slope1Bps: 400,
                slope2Bps: 8000,
                kinkBps: 8000
            })
        );
        b.bor.mint(address(this), 1000 * WAD);
        b.bor.approve(address(b.market), type(uint256).max);
        b.market.supplyLiquidity(1000 * WAD);
    }

    function _open() internal returns (Book memory b) {
        b = _book();
        b.col.mint(address(this), 50 * WAD);
        b.col.approve(address(b.market), 50 * WAD);
        b.market.depositCollateral(50 * WAD);
        b.market.borrow(10 * WAD);
    }

    function test_zero_borrow_mark_does_not_open_unsecured_debt() public {
        Book memory b = _book();
        b.oracle.set(address(b.bor), 0);
        uint256 cash = b.bor.balanceOf(address(this));
        try b.market.borrow(10 * WAD) {
            revert("unsecured borrow");
        } catch (bytes memory reason) {
            require(bytes4(reason) == IsolatedLendingMarket.BadPrice.selector, "zero mark is not a usable price");
        }
        require(b.market.debtOf(address(this)) == 0, "no debt");
        require(b.market.collateralOf(address(this)) == 0, "no collateral");
        require(b.bor.balanceOf(address(this)) == cash, "borrow tokens stayed");
    }

    function test_zero_borrow_mark_does_not_report_the_position_healthy() public {
        Book memory b = _open();
        uint256 colBefore = b.market.collateralOf(address(this));
        uint256 debtBefore = b.market.debtOf(address(this));
        require(debtBefore > 0 && colBefore > 0, "position");
        b.oracle.set(address(b.bor), 0);
        try b.market.liquidate(address(this), debtBefore) {
            revert("liquidate treated a zero borrow mark as a price");
        } catch (bytes memory reason) {
            require(bytes4(reason) != IsolatedLendingMarket.Healthy.selector, "Healthy because the borrow mark is zero");
            require(bytes4(reason) == IsolatedLendingMarket.BadPrice.selector, "zero mark is not a usable price");
        }
        require(b.market.collateralOf(address(this)) == colBefore, "collateral stays");
        require(b.market.debtOf(address(this)) == debtBefore, "debt stays");
    }

    function test_zero_collateral_mark_does_not_divide_on_liquidate() public {
        Book memory b = _open();
        uint256 colBefore = b.market.collateralOf(address(this));
        uint256 debtBefore = b.market.debtOf(address(this));
        b.oracle.set(address(b.col), 0);
        try b.market.liquidate(address(this), debtBefore) {
            revert("liquidate used a zero collateral mark");
        } catch (bytes memory reason) {
            require(bytes4(reason) != PANIC, "divided by a zero collateral mark");
            require(bytes4(reason) == IsolatedLendingMarket.BadPrice.selector, "zero mark is not a usable price");
        }
        require(b.market.collateralOf(address(this)) == colBefore, "collateral not seized at a zero mark");
        require(b.market.debtOf(address(this)) == debtBefore, "debt stays");
    }

    function test_usable_mark_still_seizes_underwater_collateral() public {
        Book memory b = _open();
        uint256 before = b.market.collateralOf(address(this));
        // 50 collateral at 20 against 10 debt at 100 is under the 80% threshold.
        b.oracle.set(address(b.col), 20 * WAD);
        b.market.liquidate(address(this), b.market.debtOf(address(this)));
        require(b.market.collateralOf(address(this)) < before, "underwater collateral seized");
        require(b.col.balanceOf(address(this)) > 0, "keeper received collateral");
    }
}

/// Callback that returns without borrowing. That return is not a nested borrow.
contract SilentBorrowRecipient {
    function onBorrowTransfer(IsolatedLendingMarket, uint256) external {}
}

/// L988: the nested borrow is the in-flight recipient. A zero-collateral Unhealthy
/// from the token is not proof that recipient was blocked.
contract IsolatedLendingBorrowReenterTest {
    uint256 private constant WAD = 1e18;

    function _book() internal returns (ReenteringBorrowToken token, MockERC20 col, IsolatedLendingMarket market) {
        token = new ReenteringBorrowToken();
        col = new MockERC20();
        FixedMarkOracle oracle = new FixedMarkOracle();
        market = new IsolatedLendingMarket(
            IsolatedLendingMarket.MarketConfig({
                collateralToken: address(col),
                borrowToken: address(token),
                oracle: address(oracle),
                collateralAssetForOracle: address(col),
                borrowAssetForOracle: address(token),
                maxLtvBps: 5000,
                liquidationThresholdBps: 8000,
                liquidationBonusBps: 500,
                closeFactorBps: 5000,
                reserveFactorBps: 1000,
                baseRateBps: 200,
                slope1Bps: 400,
                slope2Bps: 8000,
                kinkBps: 8000
            })
        );
        token.mint(address(this), 1000 * WAD);
        token.approve(address(market), type(uint256).max);
        market.supplyLiquidity(1000 * WAD);
    }

    function test_recipient_borrow_sets_the_flag_when_it_returns() public {
        (ReenteringBorrowToken token, MockERC20 col, IsolatedLendingMarket market) = _book();
        InFlightBorrower borrower = new InFlightBorrower(market, address(col), token);
        col.mint(address(this), 50 * WAD);
        col.approve(address(borrower), 50 * WAD);
        token.arm(market, 10 * WAD);
        borrower.depositAndBorrow(50 * WAD, 10 * WAD);

        require(token.reenterAttempted(), "recipient was not asked");
        require(token.reenterSucceeded(), "recipient borrow returned");
        require(market.debtOf(address(borrower)) == 10 * WAD + 10 * WAD, "both borrows are the recipient's");
        require(market.debtOf(address(token)) == 0, "token did not borrow");

        vm.prank(address(token));
        try market.borrow(10 * WAD) {
            revert("zero-collateral token borrow");
        } catch (bytes memory reason) {
            require(bytes4(reason) == IsolatedLendingMarket.Unhealthy.selector, "token has no collateral");
        }
        require(token.reenterSucceeded(), "token Unhealthy replaced the recipient result");
        require(market.debtOf(address(token)) == 0, "token Unhealthy minted debt");
    }

    function test_callback_that_does_not_borrow_leaves_the_flag_false() public {
        (ReenteringBorrowToken token, MockERC20 col, IsolatedLendingMarket market) = _book();
        SilentBorrowRecipient borrower = new SilentBorrowRecipient();
        col.mint(address(borrower), 50 * WAD);
        vm.prank(address(borrower));
        col.approve(address(market), 50 * WAD);
        vm.prank(address(borrower));
        market.depositCollateral(50 * WAD);
        token.arm(market, 10 * WAD);
        vm.prank(address(borrower));
        market.borrow(10 * WAD);

        require(token.reenterAttempted(), "hook ran");
        require(token.reenterSucceeded() == false, "empty callback is not a borrow");
        require(market.debtOf(address(borrower)) == 10 * WAD, "only the outer borrow");
        require(market.debtOf(address(token)) == 0, "token did not borrow");
    }

    function test_recipient_borrow_that_reverts_does_not_set_the_flag() public {
        (ReenteringBorrowToken token, MockERC20 col, IsolatedLendingMarket market) = _book();
        InFlightBorrower borrower = new InFlightBorrower(market, address(col), token);
        col.mint(address(this), 50 * WAD);
        col.approve(address(borrower), 50 * WAD);
        // The collateral amount cannot fit under the 50% LTV once 10 is already borrowed.
        token.arm(market, 50 * WAD);
        borrower.depositAndBorrow(50 * WAD, 10 * WAD);

        require(token.reenterAttempted(), "recipient was asked");
        require(token.reenterSucceeded() == false, "reverted borrow did not return");
        require(market.debtOf(address(borrower)) == 10 * WAD, "nested borrow rolled back");
        require(market.debtOf(address(token)) == 0, "token did not borrow");
    }

    function test_token_unhealthy_is_not_proof_the_borrower_was_blocked() public {
        (ReenteringBorrowToken token, MockERC20 col, IsolatedLendingMarket market) = _book();
        address eoa = address(0xB0B);
        col.mint(eoa, 50 * WAD);
        vm.prank(eoa);
        col.approve(address(market), 50 * WAD);
        vm.prank(eoa);
        market.depositCollateral(50 * WAD);
        token.arm(market, 10 * WAD);
        vm.prank(eoa);
        market.borrow(10 * WAD);

        require(token.reenterAttempted(), "hook ran");
        require(token.reenterSucceeded() == false, "eoa did not borrow during the transfer");
        require(market.debtOf(eoa) == 10 * WAD, "outer borrow only");
        require(market.debtOf(address(token)) == 0, "token did not borrow");

        vm.prank(address(token));
        try market.borrow(10 * WAD) {
            revert("zero-collateral token borrow");
        } catch (bytes memory reason) {
            require(bytes4(reason) == IsolatedLendingMarket.Unhealthy.selector, "token has no collateral");
        }

        vm.prank(eoa);
        market.borrow(10 * WAD);
        require(market.debtOf(eoa) == 10 * WAD + 10 * WAD, "borrower was not blocked");
        require(token.reenterSucceeded() == false, "token Unhealthy is not a recipient result");
        require(market.debtOf(address(token)) == 0, "token still has no debt");
    }
}
