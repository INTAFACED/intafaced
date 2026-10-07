// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConstantProductPool} from "../../contracts/amm/ConstantProductPool.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// Later mint must return the surplus of the larger side and leave it out of reserves.
contract ConstantProductPoolMintSurplusTest {
    function _pool() internal returns (ConstantProductPool pool, MockERC20 token0, MockERC20 token1) {
        MockERC20 a = new MockERC20();
        MockERC20 b = new MockERC20();
        pool = new ConstantProductPool(address(a), address(b), 30);
        token0 = MockERC20(pool.token0());
        token1 = MockERC20(pool.token1());
        token0.mint(address(this), 10_000_000);
        token1.mint(address(this), 10_000_000);
        token0.approve(address(pool), type(uint256).max);
        token1.approve(address(pool), type(uint256).max);
    }

    function test_later_mint_refunds_surplus_and_does_not_book_it() public {
        (ConstantProductPool pool, MockERC20 token0, MockERC20 token1) = _pool();
        uint256 seed = 1_000_000;
        pool.mint(address(this), seed, seed);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        require(uint256(r0) == seed && uint256(r1) == seed, "first mint books both");

        uint256 supply = pool.totalSupply();
        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));
        uint256 amount0 = seed;
        uint256 amount1 = seed * 5 / 2;
        uint256 minted = pool.mint(address(this), amount0, amount1);

        require(minted == amount0 * supply / uint256(r0), "lp is the limiting side");
        (uint112 r0After, uint112 r1After,) = pool.getReserves();
        require(uint256(r0After) == uint256(r0) + amount0, "reserve0 takes the match");
        require(uint256(r1After) == uint256(r1) + amount0, "reserve1 drops the surplus");
        require(token0.balanceOf(address(this)) == bal0 - amount0, "token0 fully used");
        require(token1.balanceOf(address(this)) == bal1 - amount0, "token1 surplus refunded");
    }

    function test_later_mint_refunds_token0_surplus() public {
        (ConstantProductPool pool, MockERC20 token0, MockERC20 token1) = _pool();
        uint256 seed = 1_000_000;
        pool.mint(address(this), seed, seed);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 supply = pool.totalSupply();
        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));
        uint256 minted = pool.mint(address(this), seed * 5 / 2, seed);
        require(minted == seed * supply / uint256(r1), "lp is the limiting side");
        (uint112 r0After, uint112 r1After,) = pool.getReserves();
        require(uint256(r0After) == uint256(r0) + seed, "token0 surplus not booked");
        require(uint256(r1After) == uint256(r1) + seed, "token1 fully booked");
        require(token0.balanceOf(address(this)) == bal0 - seed, "token0 surplus refunded");
        require(token1.balanceOf(address(this)) == bal1 - seed, "token1 fully used");
    }

    function test_first_mint_books_both_sides_when_amounts_differ() public {
        (ConstantProductPool pool, MockERC20 token0, MockERC20 token1) = _pool();
        uint256 before0 = token0.balanceOf(address(this));
        uint256 before1 = token1.balanceOf(address(this));
        pool.mint(address(this), 1_000_000, 4_000_000);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        require(uint256(r0) == 1_000_000 && uint256(r1) == 4_000_000, "first mint books both");
        require(token0.balanceOf(address(this)) == before0 - 1_000_000, "first mint no refund 0");
        require(token1.balanceOf(address(this)) == before1 - 4_000_000, "first mint no refund 1");
    }

    function test_proportional_later_mint_has_no_surplus() public {
        (ConstantProductPool pool, MockERC20 token0, MockERC20 token1) = _pool();
        pool.mint(address(this), 1_000_000, 4_000_000);
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 supply = pool.totalSupply();
        uint256 before0 = token0.balanceOf(address(this));
        uint256 before1 = token1.balanceOf(address(this));
        uint256 minted = pool.mint(address(this), 500_000, 2_000_000);
        require(minted == 500_000 * supply / uint256(r0), "proportional lp");
        (uint112 r0After, uint112 r1After,) = pool.getReserves();
        require(uint256(r0After) == uint256(r0) + 500_000, "proportional reserve0");
        require(uint256(r1After) == uint256(r1) + 2_000_000, "proportional reserve1");
        require(token0.balanceOf(address(this)) == before0 - 500_000, "no refund 0");
        require(token1.balanceOf(address(this)) == before1 - 2_000_000, "no refund 1");
    }

    function test_burn_stays_pro_rata() public {
        (ConstantProductPool pool, MockERC20 token0, MockERC20 token1) = _pool();
        pool.mint(address(this), 1_000_000, 1_000_000);
        uint256 minted = pool.mint(address(this), 500_000, 500_000);
        uint256 burnLp = minted / 2;
        (uint112 r0, uint112 r1,) = pool.getReserves();
        uint256 expect0 = burnLp * uint256(r0) / pool.totalSupply();
        uint256 expect1 = burnLp * uint256(r1) / pool.totalSupply();
        uint256 before0 = token0.balanceOf(address(this));
        uint256 before1 = token1.balanceOf(address(this));
        (uint256 out0, uint256 out1) = pool.burn(address(this), burnLp);
        require(out0 == expect0 && out1 == expect1, "burn is pro-rata");
        require(token0.balanceOf(address(this)) == before0 + out0, "burn pays token0");
        require(token1.balanceOf(address(this)) == before1 + out1, "burn pays token1");
    }
}
