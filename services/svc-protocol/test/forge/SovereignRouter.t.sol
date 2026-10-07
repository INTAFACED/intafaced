// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConstantProductPool} from "../../contracts/amm/ConstantProductPool.sol";
import {IERC20Minimal} from "../../contracts/amm/IERC20Minimal.sol";
import {SovereignRouter} from "../../contracts/router/SovereignRouter.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// Foundry cheatcodes without vendoring forge-std (no submodule).
interface Vm {
    function expectCall(address callee, bytes calldata data, uint64 count) external;
    function expectRevert(bytes4 revertData) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// L341: a blank slippage floor is BadAmount before any pull.
contract SovereignRouterForgeTest {
    function test_swapExactIn_zero_minAmountOut_reverts_and_does_not_pull() public {
        MockERC20 tokenIn = new MockERC20();
        MockERC20 tokenOut = new MockERC20();
        ConstantProductPool pool = new ConstantProductPool(address(tokenIn), address(tokenOut), 30);
        tokenIn.mint(address(this), 1_000_000);
        tokenOut.mint(address(this), 1_000_000);
        tokenIn.approve(address(pool), 500_000);
        tokenOut.approve(address(pool), 500_000);
        pool.mint(address(this), 500_000, 500_000);

        SovereignRouter router = new SovereignRouter();
        uint256 amountIn = 1_000;
        tokenIn.approve(address(router), amountIn);
        uint256 before = tokenIn.balanceOf(address(this));
        uint256 allowanceBefore = tokenIn.allowance(address(this), address(router));

        vm.expectCall(
            address(tokenIn),
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, address(this), address(router), amountIn),
            0
        );
        vm.expectRevert(SovereignRouter.BadAmount.selector);
        router.swapExactIn(address(pool), address(tokenIn), amountIn, 0, address(this));

        require(tokenIn.balanceOf(address(this)) == before, "input not pulled");
        require(tokenIn.balanceOf(address(router)) == 0, "router holds nothing");
        require(tokenIn.allowance(address(this), address(router)) == allowanceBefore, "allowance untouched");
        require(tokenOut.balanceOf(address(this)) == 500_000, "output untouched");
    }
}
