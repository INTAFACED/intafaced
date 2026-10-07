// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FairLaunch} from "../../contracts/launch/FairLaunch.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

interface Vm {
    function warp(uint256 newTimestamp) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// Non-creator. Holds sale inventory and is the account that calls `fund`.
contract SaleFunder {
    function approve(MockERC20 token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }

    function fund(FairLaunch launch) external {
        launch.fund();
    }

    function contribute(FairLaunch launch, uint256 amount) external {
        launch.contribute(amount);
    }
}

/// A fund after the sale window must not move sale inventory onto the launch.
contract FairLaunchSaleWindowTest {
    uint256 private constant SALE_AMOUNT = 1_000_000;
    uint256 private constant RAISE_CAP = 500_000;
    uint256 private constant MIN_RAISE = 100_000;
    uint256 private constant CONTRIBUTION = 100_000;

    function test_fund_after_endTime_does_not_transfer_sale_inventory() public {
        SaleFunder funder = new SaleFunder();
        (FairLaunch launch, MockERC20 sale,) = _deploy();
        require(address(funder) != launch.creator(), "funder is the creator");

        sale.mint(address(funder), SALE_AMOUNT);
        funder.approve(sale, address(launch), SALE_AMOUNT);
        require(sale.balanceOf(address(funder)) == SALE_AMOUNT, "funder missing inventory");
        require(sale.balanceOf(address(launch)) == 0, "launch prefunded");

        vm.warp(uint256(launch.endTime()) + 1);

        try funder.fund(launch) {} catch {}

        require(sale.balanceOf(address(launch)) == 0, "late fund transferred sale inventory");
        require(sale.balanceOf(address(funder)) == SALE_AMOUNT, "caller lost inventory");
        require(launch.funded() == false, "late fund was recorded");
        require(launch.totalRaised() == 0, "late fund raised quote");

        launch.finalize();
        require(launch.finalized() == true, "closed sale did not finalize");
        require(launch.success() == false, "empty closed sale succeeded");

        uint256 creatorBefore = sale.balanceOf(address(this));
        try launch.reclaimSale() {} catch {}
        require(sale.balanceOf(address(this)) == creatorBefore, "creator reclaimed a late fund");
        require(sale.balanceOf(address(launch)) == 0, "late fund stayed on the launch");
        require(sale.balanceOf(address(funder)) == SALE_AMOUNT, "reclaim took the funder inventory");
    }

    function test_fund_inside_window_pulls_and_records_contribution() public {
        SaleFunder funder = new SaleFunder();
        (FairLaunch launch, MockERC20 sale, MockERC20 quote) = _deploy();

        sale.mint(address(funder), SALE_AMOUNT);
        funder.approve(sale, address(launch), SALE_AMOUNT);

        vm.warp(uint256(launch.endTime()) - 1);
        require(block.timestamp >= launch.startTime() && block.timestamp < launch.endTime(), "not inside window");

        funder.fund(launch);
        require(sale.balanceOf(address(launch)) == SALE_AMOUNT, "fund did not pull sale inventory");
        require(sale.balanceOf(address(funder)) == 0, "funder kept funded inventory");
        require(launch.funded() == true, "fund was not recorded");

        quote.mint(address(funder), CONTRIBUTION);
        funder.approve(quote, address(launch), CONTRIBUTION);
        funder.contribute(launch, CONTRIBUTION);
        require(launch.totalRaised() == CONTRIBUTION, "contribution not recorded");
        require(launch.contributed(address(funder)) == CONTRIBUTION, "wallet contribution not recorded");
    }

    function _deploy() internal returns (FairLaunch launch, MockERC20 sale, MockERC20 quote) {
        sale = new MockERC20();
        quote = new MockERC20();
        uint64 start = uint64(block.timestamp);
        uint64 end = start + 7 days;
        launch = new FairLaunch(
            address(sale), address(quote), SALE_AMOUNT, RAISE_CAP, MIN_RAISE, start, end, 0, 0, 0
        );
    }
}
