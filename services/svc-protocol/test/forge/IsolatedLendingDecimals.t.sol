// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IsolatedLendingMarket} from "../../contracts/lending/IsolatedLendingMarket.sol";

/// One whole token is `10 ** decimals` raw units. Marks price that whole token.
contract DecimalToken {
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
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
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MarkOracle {
    mapping(address => uint256) public priceWad;

    function set(address asset, uint256 price) external {
        priceWad[asset] = price;
    }

    function getMark(address asset) external view returns (uint256 price, uint64 updatedAt) {
        price = priceWad[asset];
        require(price != 0, "mark");
        updatedAt = uint64(block.timestamp);
    }
}

/// L335: collateral with more decimals must not fund a borrow larger than its whole-token
/// value, and a borrow token with more decimals must not seize extra collateral.
contract IsolatedLendingDecimalsTest {
    uint256 private constant WAD = 1e18;

    function test_more_decimal_collateral_cannot_borrow_past_whole_token_value() public {
        DecimalToken col = new DecimalToken(18);
        DecimalToken bor = new DecimalToken(6);
        MarkOracle oracle = new MarkOracle();
        oracle.set(address(col), WAD);
        oracle.set(address(bor), WAD);
        IsolatedLendingMarket market = _market(col, bor, oracle, 0);

        col.mint(address(this), WAD);
        col.approve(address(market), WAD);
        market.depositCollateral(WAD);

        // Enough cash that a refusal is unhealthy, not an empty pool.
        bor.mint(address(this), 10_000_000);
        bor.approve(address(market), 10_000_000);
        market.supplyLiquidity(10_000_000);

        // 1 collateral token, equal marks, 50% LTV: half a 6-decimal borrow token.
        market.borrow(500_000);
        require(market.debtOf(address(this)) == 500_000, "fair borrow");

        // Two whole borrow tokens are worth more than the one collateral token.
        try market.borrow(1_500_000) {
            revert("borrowed past collateral value");
        } catch (bytes memory reason) {
            require(
                reason.length >= 4 && bytes4(reason) == IsolatedLendingMarket.Unhealthy.selector, "overborrow reason"
            );
        }
        require(market.debtOf(address(this)) == 500_000, "debt unchanged");
    }

    function test_higher_decimal_borrow_does_not_over_seize() public {
        DecimalToken col = new DecimalToken(6);
        DecimalToken bor = new DecimalToken(7);
        MarkOracle oracle = new MarkOracle();
        oracle.set(address(col), WAD);
        oracle.set(address(bor), WAD);
        IsolatedLendingMarket market = _market(col, bor, oracle, 500);

        // 1000 whole collateral tokens. 50 whole borrow tokens is 5% of that value,
        // and exactly 50% of the raw balances, which the unscaled check allows.
        uint256 colRaw = 1_000_000_000;
        uint256 debtRaw = 500_000_000;
        col.mint(address(this), colRaw);
        col.approve(address(market), colRaw);
        market.depositCollateral(colRaw);
        bor.mint(address(this), debtRaw);
        bor.approve(address(market), debtRaw);
        market.supplyLiquidity(debtRaw);
        market.borrow(debtRaw);
        require(market.debtOf(address(this)) == debtRaw, "opened");

        // 50 whole borrow tokens at 17x the collateral mark is 850, past the 80% line on 1000.
        oracle.set(address(bor), 17 * WAD);
        bor.approve(address(market), debtRaw);
        uint256 before = col.balanceOf(address(this));
        market.liquidate(address(this), debtRaw);
        uint256 seized = col.balanceOf(address(this)) - before;

        // 50 * 17 * 1.05 = 892.5 whole collateral tokens, 6 decimals.
        require(seized == 892_500_000, "seize");
        require(market.collateralOf(address(this)) == colRaw - 892_500_000, "collateral left");
    }

    function _market(DecimalToken col, DecimalToken bor, MarkOracle oracle, uint16 bonusBps)
        private
        returns (IsolatedLendingMarket)
    {
        return new IsolatedLendingMarket(
            IsolatedLendingMarket.MarketConfig({
                collateralToken: address(col),
                borrowToken: address(bor),
                oracle: address(oracle),
                collateralAssetForOracle: address(col),
                borrowAssetForOracle: address(bor),
                maxLtvBps: 5_000,
                liquidationThresholdBps: 8_000,
                liquidationBonusBps: bonusBps,
                closeFactorBps: 10_000,
                reserveFactorBps: 0,
                baseRateBps: 0,
                slope1Bps: 0,
                slope2Bps: 0,
                kinkBps: 8_000
            })
        );
    }
}
