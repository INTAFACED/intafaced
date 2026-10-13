// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccountFactory} from "../../contracts/AccountFactory.sol";
import {SessionKeyLib} from "../../contracts/SessionKeyLib.sol";
import {SmartAccount} from "../../contracts/SmartAccount.sol";
import {ConstantProductPool} from "../../contracts/amm/ConstantProductPool.sol";
import {SovereignRouter} from "../../contracts/router/SovereignRouter.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// Attacker-deployed "pool": claims to hold tokenIn, steals it, lies about amountOut.
/// (From the security review of the recipient fix; it passed the recipient rule
/// because `to` is the account.)
contract FakePool {
    address public immutable tok;
    address public immutable thief;

    constructor(address t, address th) {
        tok = t;
        thief = th;
    }

    function token0() external view returns (address) {
        return tok;
    }

    function token1() external view returns (address) {
        return tok;
    }

    function swapExactIn(address tokenIn, uint256 amountIn, uint256 minAmountOut, address) external returns (uint256) {
        MockERC20(tokenIn).transferFrom(msg.sender, thief, amountIn);
        return minAmountOut;
    }
}

/// A session that may call the router can only route through pools the owner put in its targets.
contract SessionRouterPoolTest {
    SmartAccount internal account;
    SovereignRouter internal router;
    MockERC20 internal usdc;
    MockERC20 internal other;

    // The test contract is the EntryPoint, the owner and the session key.
    function _setUp(address[] memory extraTargets) internal returns (SessionKeyLib.SessionSpec memory spec) {
        SmartAccount impl = new SmartAccount(address(this));
        AccountFactory factory = new AccountFactory(address(impl));
        account = SmartAccount(payable(factory.createAccount(address(this), bytes32(uint256(1)))));
        router = new SovereignRouter();
        usdc = new MockERC20();
        other = new MockERC20();
        usdc.mint(address(account), 1_000e18);
        // The owner does the normal thing for router trading: approves the router.
        account.execute(address(usdc), 0, abi.encodeWithSelector(usdc.approve.selector, address(router), type(uint256).max));

        spec.key = address(this);
        spec.validUntil = uint48(block.timestamp + 1 days);
        spec.targets = new address[](1 + extraTargets.length);
        spec.targets[0] = address(router);
        for (uint256 i = 0; i < extraTargets.length; i++) spec.targets[i + 1] = extraTargets[i];
        spec.selectors = new bytes4[](1);
        spec.selectors[0] = SovereignRouter.swapExactIn.selector;
        account.grantSession(spec);
    }

    function _swap(SessionKeyLib.SessionSpec memory spec, address pool, address to) internal returns (bytes memory) {
        return account.executeWithSession(
            spec,
            address(router),
            0,
            abi.encodeWithSelector(SovereignRouter.swapExactIn.selector, pool, address(usdc), 1_000e18, uint256(1), to)
        );
    }

    /// The review PoC. Before the fix this drained the account; now the fake pool is refused.
    function test_router_fake_pool_is_refused_even_when_recipient_is_the_account() public {
        SessionKeyLib.SessionSpec memory spec = _setUp(new address[](0));
        address thief = address(0xBAD);
        FakePool fake = new FakePool(address(usdc), thief);
        try this.attack(spec, address(fake)) {
            revert("fake pool must be refused");
        } catch (bytes memory err) {
            require(bytes4(err) == SessionKeyLib.SessionTargetArgNotAllowed.selector, "refused for the wrong reason");
        }
        require(usdc.balanceOf(thief) == 0, "thief got funds");
        require(usdc.balanceOf(address(account)) == 1_000e18, "account lost funds");
    }

    function attack(SessionKeyLib.SessionSpec memory spec, address pool) external {
        _swap(spec, pool, address(account));
    }

    /// Control: a real pool the owner put in the session's targets works end to end, and the
    /// output lands in the account. The rule is "owner-chosen pool", not a block on the router.
    function test_router_swap_through_a_pool_the_owner_trusted_passes() public {
        SmartAccount impl = new SmartAccount(address(this));
        AccountFactory factory = new AccountFactory(address(impl));
        account = SmartAccount(payable(factory.createAccount(address(this), bytes32(uint256(2)))));
        router = new SovereignRouter();
        usdc = new MockERC20();
        other = new MockERC20();
        ConstantProductPool pool = new ConstantProductPool(address(usdc), address(other), 30);
        usdc.mint(address(this), 10_000e18);
        other.mint(address(this), 10_000e18);
        usdc.approve(address(pool), type(uint256).max);
        other.approve(address(pool), type(uint256).max);
        pool.mint(address(this), 10_000e18, 10_000e18);

        usdc.mint(address(account), 100e18);
        account.execute(address(usdc), 0, abi.encodeWithSelector(usdc.approve.selector, address(router), type(uint256).max));

        SessionKeyLib.SessionSpec memory spec;
        spec.key = address(this);
        spec.validUntil = uint48(block.timestamp + 1 days);
        spec.targets = new address[](2);
        spec.targets[0] = address(router);
        spec.targets[1] = address(pool);
        spec.selectors = new bytes4[](1);
        spec.selectors[0] = SovereignRouter.swapExactIn.selector;
        account.grantSession(spec);

        account.executeWithSession(
            spec,
            address(router),
            0,
            abi.encodeWithSelector(SovereignRouter.swapExactIn.selector, address(pool), address(usdc), 100e18, uint256(1), address(account))
        );
        require(usdc.balanceOf(address(account)) == 0, "input not spent");
        require(other.balanceOf(address(account)) > 0, "output did not come back to the account");
    }
}
