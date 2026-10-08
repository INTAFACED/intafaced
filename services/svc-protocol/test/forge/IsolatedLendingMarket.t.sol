// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPriceOracle} from "../../contracts/oracle/IPriceOracle.sol";
import {IsolatedLendingMarket} from "../../contracts/lending/IsolatedLendingMarket.sol";
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
