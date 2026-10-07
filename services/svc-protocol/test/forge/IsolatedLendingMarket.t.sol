// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

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
