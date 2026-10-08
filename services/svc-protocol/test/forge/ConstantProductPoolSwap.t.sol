// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ConstantProductPool} from "../../contracts/amm/ConstantProductPool.sol";
import {IERC20Minimal} from "../../contracts/amm/IERC20Minimal.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// Foundry cheatcodes without vendoring forge-std (no submodule).
interface Vm {
    function expectCall(address callee, bytes calldata data, uint64 count) external;
    function expectRevert(bytes4 revertData) external;
    function warp(uint256 newTimestamp) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// L984: a swap needs the caller's deadline, and exact-output needs an input ceiling.
contract ConstantProductPoolSwapForgeTest {
    function test_swapExactIn_missing_deadline_does_not_pull() public {
        (ConstantProductPool pool, MockERC20 tokenIn, MockERC20 tokenOut) = _seed();
        uint256 amountIn = 1_000;
        uint256 quoted = pool.getAmountOut(amountIn, address(tokenIn));
        tokenIn.approve(address(pool), amountIn);

        vm.expectCall(
            address(tokenIn),
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, address(this), address(pool), amountIn),
            0
        );
        vm.expectRevert(ConstantProductPool.DeadlineMissing.selector);
        pool.swapExactIn(address(tokenIn), amountIn, quoted, address(this), 0);

        require(tokenIn.balanceOf(address(this)) == 500_000, "input stays");
        require(tokenOut.balanceOf(address(this)) == 500_000, "output stays");
    }

    function test_swapExactIn_expired_deadline_does_not_pull() public {
        (ConstantProductPool pool, MockERC20 tokenIn, MockERC20 tokenOut) = _seed();
        uint256 amountIn = 1_000;
        uint256 quoted = pool.getAmountOut(amountIn, address(tokenIn));
        uint256 deadline = block.timestamp;
        vm.warp(deadline + 1);
        tokenIn.approve(address(pool), amountIn);

        vm.expectCall(
            address(tokenIn),
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, address(this), address(pool), amountIn),
            0
        );
        vm.expectRevert(ConstantProductPool.DeadlineExpired.selector);
        pool.swapExactIn(address(tokenIn), amountIn, quoted, address(this), deadline);

        require(tokenIn.balanceOf(address(this)) == 500_000, "input stays");
        require(tokenOut.balanceOf(address(this)) == 500_000, "output stays");
    }

    function test_swapExactIn_still_enforces_minAmountOut() public {
        (ConstantProductPool pool, MockERC20 tokenIn, MockERC20 tokenOut) = _seed();
        uint256 amountIn = 1_000;
        uint256 quoted = pool.getAmountOut(amountIn, address(tokenIn));
        require(quoted > 0, "pool quoted an out");
        tokenIn.approve(address(pool), amountIn);

        vm.expectRevert(ConstantProductPool.InsufficientOutput.selector);
        pool.swapExactIn(address(tokenIn), amountIn, quoted + 1, address(this), block.timestamp);

        require(tokenIn.balanceOf(address(this)) == 500_000, "input stays");
        require(tokenOut.balanceOf(address(this)) == 500_000, "output stays");
    }

    function test_swapExactIn_fills_at_the_quoted_floor_for_this_block() public {
        (ConstantProductPool pool, MockERC20 tokenIn, MockERC20 tokenOut) = _seed();
        uint256 amountIn = 1_000;
        uint256 quoted = pool.getAmountOut(amountIn, address(tokenIn));
        tokenIn.approve(address(pool), amountIn);

        uint256 amountOut = pool.swapExactIn(address(tokenIn), amountIn, quoted, address(this), block.timestamp);

        require(amountOut >= quoted, "floor held");
        require(tokenOut.balanceOf(address(this)) == 500_000 + amountOut, "out paid");
        require(tokenIn.balanceOf(address(this)) == 500_000 - amountIn, "in taken");
    }

    function test_swap_missing_deadline_does_not_pay() public {
        (ConstantProductPool pool,, MockERC20 tokenOut, uint256 quoted) = _quotedIn();
        _expectNoPay(tokenOut, quoted);
        vm.expectRevert(ConstantProductPool.DeadlineMissing.selector);
        pool.swap(0, quoted, address(this), 0, 1_000);
        _reservesHeld(pool, tokenOut);
    }

    function test_swap_expired_deadline_does_not_pay() public {
        (ConstantProductPool pool,, MockERC20 tokenOut, uint256 quoted) = _quotedIn();
        uint256 deadline = block.timestamp;
        vm.warp(deadline + 1);
        _expectNoPay(tokenOut, quoted);
        vm.expectRevert(ConstantProductPool.DeadlineExpired.selector);
        pool.swap(0, quoted, address(this), deadline, 1_000);
        _reservesHeld(pool, tokenOut);
    }

    function test_swap_missing_max_input_does_not_pay() public {
        (ConstantProductPool pool, MockERC20 tokenIn, MockERC20 tokenOut, uint256 quoted) = _quotedIn();
        tokenIn.transfer(address(pool), 1_000);
        _expectNoPay(tokenOut, quoted);
        vm.expectRevert(ConstantProductPool.MaxInputMissing.selector);
        pool.swap(0, quoted, address(this), block.timestamp, 0);
        _reservesHeld(pool, tokenOut);
    }

    function test_swap_input_above_ceiling_does_not_pay() public {
        (ConstantProductPool pool, MockERC20 tokenIn, MockERC20 tokenOut, uint256 quoted) = _quotedIn();
        tokenIn.transfer(address(pool), 1_000);
        vm.expectRevert(ConstantProductPool.ExcessiveInput.selector);
        pool.swap(0, quoted, address(this), block.timestamp, 1_000 - 1);
        require(tokenOut.balanceOf(address(this)) == 500_000, "out not paid");
        _reservesHeld(pool, tokenOut);
    }

    function test_swap_fills_when_deadline_and_input_ceiling_hold() public {
        (ConstantProductPool pool, MockERC20 tokenIn, MockERC20 tokenOut, uint256 quoted) = _quotedIn();
        tokenIn.transfer(address(pool), 1_000);
        pool.swap(0, quoted, address(this), block.timestamp, 1_000);
        require(tokenOut.balanceOf(address(this)) == 500_000 + quoted, "quoted out paid");
        require(tokenIn.balanceOf(address(this)) == 500_000 - 1_000, "ceiling was the input");
    }

    function _expectNoPay(MockERC20 tokenOut, uint256 quoted) private {
        vm.expectCall(
            address(tokenOut), abi.encodeWithSelector(IERC20Minimal.transfer.selector, address(this), quoted), 0
        );
    }

    function _reservesHeld(ConstantProductPool pool, MockERC20 tokenOut) private view {
        (uint112 r0, uint112 r1,) = pool.getReserves();
        require(r0 == 500_000 && r1 == 500_000, "reserves held");
        require(tokenOut.balanceOf(address(pool)) == 500_000, "output still in pool");
    }

    function _quotedIn()
        private
        returns (ConstantProductPool pool, MockERC20 tokenIn, MockERC20 tokenOut, uint256 quoted)
    {
        (pool, tokenIn, tokenOut) = _seed();
        quoted = pool.getAmountOut(1_000, address(tokenIn));
        require(quoted > 0, "pool quoted an out");
    }

    /// Same seed as the router forge test. The quote comes from the pool.
    function _seed() private returns (ConstantProductPool pool, MockERC20 tokenIn, MockERC20 tokenOut) {
        MockERC20 a = new MockERC20();
        MockERC20 b = new MockERC20();
        pool = new ConstantProductPool(address(a), address(b), 30);
        tokenIn = MockERC20(pool.token0());
        tokenOut = MockERC20(pool.token1());
        tokenIn.mint(address(this), 1_000_000);
        tokenOut.mint(address(this), 1_000_000);
        tokenIn.approve(address(pool), 500_000);
        tokenOut.approve(address(pool), 500_000);
        pool.mint(address(this), 500_000, 500_000);
    }
}
