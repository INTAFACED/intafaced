// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FairLaunch} from "../../contracts/launch/FairLaunch.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function store(address account, bytes32 slot, bytes32 value) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// Claim pays floor(sale credit * contribution / raise) even when the product does not fit in uint256.
contract FairLaunchAllocationForgeTest {
    uint256 private constant FULL = type(uint256).max;
    /// floor(2^255 * 2 / 3). 2^255 * 2 does not fit in uint256; the quotient does.
    uint256 private constant TWO_THIRDS_OF_2_255 =
        38597363079105398474523661669562635951089994888546854679819194669304376546645;
    /// floor(2^255 / 3).
    uint256 private constant ONE_THIRD_OF_2_255 =
        19298681539552699237261830834781317975544997444273427339909597334652188273322;

    function test_claim_pays_full_credit_when_sale_times_contribution_overflows() public {
        uint256 raised = 2;
        (FairLaunch launch, MockERC20 sale,) = _success(FULL, raised, raised, 0, 0);
        address buyer = address(0xB0B);
        _contribute(launch, buyer, raised);

        launch.finalize();

        require(launch.allocationOf(buyer) == FULL, "whole raise is the whole credit");
        vm.prank(buyer);
        launch.claim();
        require(sale.balanceOf(buyer) == FULL, "claim paid the credit");
    }

    function test_claim_pays_truncated_share_when_sale_times_contribution_overflows() public {
        uint256 inventory = uint256(1) << 255;
        (FairLaunch launch, MockERC20 sale,) = _success(inventory, 3, 1, 0, 0);
        address small = address(0xA11CE);
        address large = address(0xB0B);
        _contribute(launch, small, 1);
        _contribute(launch, large, 2);

        launch.finalize();

        require(launch.allocationOf(small) == ONE_THIRD_OF_2_255, "one part");
        require(launch.allocationOf(large) == TWO_THIRDS_OF_2_255, "two parts");

        vm.prank(small);
        launch.claim();
        vm.prank(large);
        launch.claim();
        require(sale.balanceOf(small) == ONE_THIRD_OF_2_255, "small claim");
        require(sale.balanceOf(large) == TWO_THIRDS_OF_2_255, "large claim");
    }

    function test_claim_truncates_toward_zero_when_product_fits() public {
        (FairLaunch launch, MockERC20 sale,) = _success(100, 3, 1, 0, 0);
        address small = address(0xA11CE);
        address large = address(0xB0B);
        _contribute(launch, small, 1);
        _contribute(launch, large, 2);
        launch.finalize();

        require(launch.allocationOf(small) == 33, "100 * 1 / 3");
        require(launch.allocationOf(large) == 66, "100 * 2 / 3");
        require(launch.allocationOf(address(0xC0FFEE)) == 0, "no contribution");

        vm.prank(small);
        launch.claim();
        vm.prank(large);
        launch.claim();
        require(sale.balanceOf(small) == 33, "small paid");
        require(sale.balanceOf(large) == 66, "large paid");
    }

    function test_claim_matches_half_when_large_product_fits() public {
        uint256 inventory = uint256(1) << 128;
        (FairLaunch launch, MockERC20 sale,) = _success(inventory, 4, 1, 0, 0);
        address buyer = address(0xB0B);
        _contribute(launch, buyer, 2);
        _contribute(launch, address(0xA11CE), 2);
        launch.finalize();

        require(launch.allocationOf(buyer) == uint256(1) << 127, "half of 2^128");
        vm.prank(buyer);
        launch.claim();
        require(sale.balanceOf(buyer) == uint256(1) << 127, "paid half");
    }

    function test_failed_sale_pays_nothing() public {
        MockERC20 sale = new MockERC20();
        MockERC20 quote = new MockERC20();
        uint64 start = uint64(block.timestamp);
        FairLaunch launch = new FairLaunch(
            address(sale), address(quote), 1_000, 100, 50, start, start + 1 days, 0, 0, 0
        );
        sale.mint(address(this), 1_000);
        sale.approve(address(launch), 1_000);
        launch.fund();

        address buyer = address(0xB0B);
        _contribute(launch, buyer, 10);
        vm.warp(uint256(start) + 1 days);
        launch.finalize();

        require(launch.success() == false, "below minRaise");
        require(launch.saleCredited() != 0, "inventory was credited");
        require(launch.allocationOf(buyer) == 0, "failed sale allocates nothing");
        vm.prank(buyer);
        try launch.claim() {
            revert("claim paid on a failed sale");
        } catch (bytes memory reason) {
            require(bytes4(reason) == FairLaunch.SaleFailed.selector, "sale failed");
        }
        require(sale.balanceOf(buyer) == 0, "buyer received sale tokens");

        vm.prank(buyer);
        launch.refund();
        require(quote.balanceOf(buyer) == 10, "quote returned");
    }

    function test_zero_sale_credit_pays_nothing() public {
        (FairLaunch launch, MockERC20 sale,) = _success(100, 3, 1, 0, 0);
        address buyer = address(0xB0B);
        _contribute(launch, buyer, 3);
        launch.finalize();
        require(launch.success(), "succeeded");
        // saleCredited is the second storage word. Clearing it is the zero-credit book.
        vm.store(address(launch), bytes32(uint256(1)), bytes32(0));
        require(launch.saleCredited() == 0, "credit is zero");
        require(launch.allocationOf(buyer) == 0, "zero credit allocates nothing");
        vm.prank(buyer);
        try launch.claim() {
            revert("claim paid on zero credit");
        } catch {}
        require(sale.balanceOf(buyer) == 0, "buyer received nothing");
    }

    function _success(
        uint256 inventory,
        uint256 raiseCap,
        uint256 minRaise,
        uint64 cliff,
        uint64 linear
    ) private returns (FairLaunch launch, MockERC20 sale, MockERC20 quote) {
        sale = new MockERC20();
        quote = new MockERC20();
        uint64 start = uint64(block.timestamp);
        launch = new FairLaunch(
            address(sale), address(quote), inventory, raiseCap, minRaise, start, start + 1 days, 0, cliff, linear
        );
        sale.mint(address(this), inventory);
        sale.approve(address(launch), inventory);
        launch.fund();
        require(launch.saleCredited() == inventory, "credit is the balance received");
    }

    function _contribute(FairLaunch launch, address buyer, uint256 amount) private {
        MockERC20 quote = MockERC20(launch.quoteToken());
        quote.mint(buyer, amount);
        vm.prank(buyer);
        quote.approve(address(launch), amount);
        vm.prank(buyer);
        launch.contribute(amount);
    }
}
