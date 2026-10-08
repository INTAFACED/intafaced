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
        require(launch.saleCredited() == sale.balanceOf(address(launch)), "sale credit");
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

interface TokenOps {
    function mint(address to, uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// Delivers a smaller balance than the amount argument. The shortfall belongs
/// to this token. The launch credits whatever balance it actually gained.
contract ShortTransferToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        return _transfer(from, to, amount);
    }

    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        require(balanceOf[from] >= amount, "balance");
        uint256 withheld = amount / 5;
        require(withheld > 0 && withheld < amount, "short");
        balanceOf[from] -= amount;
        balanceOf[to] += amount - withheld;
        return true;
    }
}

contract LaunchPayer {
    function approve(address token, address spender, uint256 amount) external {
        TokenOps(token).approve(spender, amount);
    }

    function contribute(FairLaunch launch, uint256 amount) external {
        launch.contribute(amount);
    }

    function refund(FairLaunch launch) external {
        launch.refund();
    }

    function claim(FairLaunch launch) external {
        launch.claim();
    }
}

/// A short transfer credits the balance received, so finalize, refund, and claim
/// cannot pay the caller-stated gross.
contract FairLaunchReceivedTest {
    uint256 private constant SALE_AMOUNT = 1_000_000;
    uint256 private constant RAISE_CAP = 500_000;
    uint256 private constant MIN_RAISE = 100_000;
    uint256 private constant CONTRIBUTION = 100_000;

    function test_fee_quote_finalize_pays_the_balance_received() public {
        MockERC20 sale = new MockERC20();
        ShortTransferToken quote = new ShortTransferToken();
        FairLaunch launch = _open(address(sale), address(quote), MIN_RAISE);
        _fundExact(sale, launch);

        LaunchPayer alice = new LaunchPayer();
        LaunchPayer bob = new LaunchPayer();
        _contribute(address(quote), alice, launch, CONTRIBUTION);
        _contribute(address(quote), bob, launch, CONTRIBUTION);

        require(launch.totalRaised() < CONTRIBUTION + CONTRIBUTION, "gross not credited");
        require(quote.balanceOf(address(launch)) == launch.totalRaised(), "raised is balance");
        vm.warp(uint256(launch.endTime()) + 1);
        launch.finalize();
        require(launch.success(), "met min on received");
        require(quote.balanceOf(address(launch)) == 0, "creator paid the received total");
    }

    function test_fee_quote_refund_does_not_pay_the_stated_gross() public {
        MockERC20 sale = new MockERC20();
        ShortTransferToken quote = new ShortTransferToken();
        FairLaunch launch = _open(address(sale), address(quote), RAISE_CAP);
        _fundExact(sale, launch);

        LaunchPayer alice = new LaunchPayer();
        LaunchPayer bob = new LaunchPayer();
        _contribute(address(quote), alice, launch, CONTRIBUTION);
        _contribute(address(quote), bob, launch, CONTRIBUTION);
        require(launch.contributed(address(alice)) < CONTRIBUTION, "alice net");
        require(launch.contributed(address(bob)) < CONTRIBUTION, "bob net");

        vm.warp(uint256(launch.endTime()) + 1);
        launch.finalize();
        require(launch.success() == false, "below min");

        _refundPaysCredit(quote, launch, alice);
        _refundPaysCredit(quote, launch, bob);
        require(quote.balanceOf(address(launch)) == 0, "quote cleared");
    }

    function test_fee_sale_claim_does_not_pay_the_stated_gross() public {
        ShortTransferToken sale = new ShortTransferToken();
        MockERC20 quote = new MockERC20();
        FairLaunch launch = _open(address(sale), address(quote), MIN_RAISE);
        uint256 before = sale.balanceOf(address(launch));
        _fund(address(sale), launch, SALE_AMOUNT);
        require(launch.saleCredited() == sale.balanceOf(address(launch)) - before, "sale credit");
        require(launch.saleCredited() < SALE_AMOUNT, "short sale");

        LaunchPayer alice = new LaunchPayer();
        LaunchPayer bob = new LaunchPayer();
        _contribute(address(quote), alice, launch, CONTRIBUTION);
        _contribute(address(quote), bob, launch, CONTRIBUTION);

        vm.warp(uint256(launch.endTime()) + 1);
        launch.finalize();
        require(launch.success(), "raised");

        uint256 gross = (launch.saleAmount() * launch.contributed(address(alice))) / launch.totalRaised();
        uint256 fair = launch.claimable(address(alice));
        require(fair < gross, "claim uses received inventory");
        _claimPays(sale, launch, alice, fair);
        _claimPays(sale, launch, bob, launch.claimable(address(bob)));
        require(sale.balanceOf(address(launch)) == 0, "sale cleared");
    }

    function _open(address sale, address quote, uint256 minRaise) internal returns (FairLaunch launch) {
        uint64 start = uint64(block.timestamp);
        launch = new FairLaunch(
            sale, quote, SALE_AMOUNT, RAISE_CAP, minRaise, start, start + 7 days, 0, 0, 0
        );
    }

    function _fundExact(MockERC20 sale, FairLaunch launch) internal {
        _fund(address(sale), launch, SALE_AMOUNT);
        require(launch.saleCredited() == SALE_AMOUNT, "exact sale");
    }

    function _fund(address sale, FairLaunch launch, uint256 amount) internal {
        TokenOps(sale).mint(address(this), amount);
        TokenOps(sale).approve(address(launch), amount);
        launch.fund();
    }

    function _contribute(address quote, LaunchPayer payer, FairLaunch launch, uint256 amount) internal {
        TokenOps(quote).mint(address(payer), amount);
        uint256 before = TokenOps(quote).balanceOf(address(launch));
        payer.approve(quote, address(launch), amount);
        payer.contribute(launch, amount);
        require(launch.contributed(address(payer)) == TokenOps(quote).balanceOf(address(launch)) - before, "credit received");
        require(launch.totalRaised() == TokenOps(quote).balanceOf(address(launch)), "total is balance");
    }

    function _refundPaysCredit(ShortTransferToken quote, FairLaunch launch, LaunchPayer payer) internal {
        uint256 credit = launch.contributed(address(payer));
        uint256 held = quote.balanceOf(address(launch));
        payer.refund(launch);
        require(held - quote.balanceOf(address(launch)) == credit, "refund paid credit");
    }

    function _claimPays(ShortTransferToken sale, FairLaunch launch, LaunchPayer payer, uint256 fair) internal {
        uint256 held = sale.balanceOf(address(launch));
        payer.claim(launch);
        require(held - sale.balanceOf(address(launch)) == fair, "claim paid credit");
    }
}
