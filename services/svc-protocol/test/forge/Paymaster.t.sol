// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation} from "../../contracts/interfaces/IAccount.sol";
import {IPaymaster} from "../../contracts/interfaces/IPaymaster.sol";
import {ScopedPaymaster} from "../../contracts/paymaster/ScopedPaymaster.sol";
import {SessionKeyLib} from "../../contracts/SessionKeyLib.sol";
import {SmartAccount} from "../../contracts/SmartAccount.sol";

/// S-A10: paymaster spends only its own float; unfunded validation fails.
contract PaymasterForgeTest {
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    receive() external payable {}

    function _op(address sender, bytes memory callData) internal pure returns (PackedUserOperation memory op) {
        op.sender = sender;
        op.callData = callData;
    }

    function test_unfunded_refuses() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        p.setAllowlisted(address(0xBEEF), true);
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(1 ether);
        PackedUserOperation memory op = _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678)));
        (, uint256 data) = p.validatePaymasterUserOp(op, bytes32(0), 1);
        require(data == SIG_VALIDATION_FAILED, "unfunded must fail");
    }

    function test_funded_allowlisted_selector_succeeds() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        p.setAllowlisted(address(0xBEEF), true);
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(1 ether);
        (bool ok, ) = payable(p).call{value: 2 ether}("");
        require(ok, "fund");
        PackedUserOperation memory op = _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678)));
        (, uint256 data) = p.validatePaymasterUserOp(op, bytes32(0), 1);
        require(data == 0, "funded allowlisted must succeed");
    }

    function test_unknown_sender_refuses() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(1 ether);
        (bool ok, ) = payable(p).call{value: 1 ether}("");
        require(ok, "fund");
        PackedUserOperation memory op = _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678)));
        (, uint256 data) = p.validatePaymasterUserOp(op, bytes32(0), 1);
        require(data == SIG_VALIDATION_FAILED, "unknown sender");
    }

    function test_unknown_selector_refuses() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        p.setAllowlisted(address(0xBEEF), true);
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(1 ether);
        (bool ok, ) = payable(p).call{value: 1 ether}("");
        require(ok, "fund");
        PackedUserOperation memory op = _op(address(0xBEEF), abi.encodePacked(bytes4(0xdeadbeef)));
        (, uint256 data) = p.validatePaymasterUserOp(op, bytes32(0), 1);
        require(data == SIG_VALIDATION_FAILED, "unknown selector");
    }

    function test_over_cost_cap_refuses() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        p.setAllowlisted(address(0xBEEF), true);
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(1);
        (bool ok, ) = payable(p).call{value: 1 ether}("");
        require(ok, "fund");
        PackedUserOperation memory op = _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678)));
        (, uint256 data) = p.validatePaymasterUserOp(op, bytes32(0), 2);
        require(data == SIG_VALIDATION_FAILED, "over cap");
    }

    function test_stranger_cannot_set_policy() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(0xA11CE));
        try p.setAllowlisted(address(0xBEEF), true) {
            revert("stranger must not set allowlist");
        } catch {}
    }

    function test_withdraw_float_is_this_contract_only() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        (bool ok, ) = payable(p).call{value: 1 ether}("");
        require(ok, "fund");
        uint256 before = address(this).balance;
        p.withdrawFloat(address(this), 1 ether);
        require(address(p).balance == 0, "float emptied");
        require(address(this).balance == before + 1 ether, "operator recovered own float");
    }

    /// One float that covers a single maxCost cannot sponsor two ops.
    /// postOp frees only the unused reservation for a later op.
    function test_second_op_cannot_share_one_float_until_unused_is_released() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        p.setAllowlisted(address(0xBEEF), true);
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(10);
        (bool ok, ) = payable(p).call{value: 10}("");
        require(ok, "fund");
        PackedUserOperation memory op = _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678)));

        (bytes memory context, uint256 first) = p.validatePaymasterUserOp(op, bytes32(0), 10);
        require(first == 0, "first op reserves the only maxCost");

        (, uint256 second) = p.validatePaymasterUserOp(op, bytes32(0), 10);
        require(second == SIG_VALIDATION_FAILED, "second op must not share one float");

        p.postOp(IPaymaster.PostOpMode.opSucceeded, context, 4, 0);

        (, uint256 overUnused) = p.validatePaymasterUserOp(op, bytes32(0), 7);
        require(overUnused == SIG_VALIDATION_FAILED, "settled gas stays committed");

        (, uint256 third) = p.validatePaymasterUserOp(op, bytes32(0), 6);
        require(third == 0, "later op uses the released unused reservation");

        (, uint256 fourth) = p.validatePaymasterUserOp(op, bytes32(0), 1);
        require(fourth == SIG_VALIDATION_FAILED, "released float is reserved again");
    }

    /// One float of 10 wei. `0x12345678` stays permitted so a rejected wrapper
    /// can be followed by a plain op that only succeeds if nothing was reserved.
    function _float() internal returns (ScopedPaymaster p) {
        p = new ScopedPaymaster(address(this), address(this));
        p.setAllowlisted(address(0xBEEF), true);
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(10);
        (bool ok, ) = payable(p).call{value: 10}("");
        require(ok, "fund");
    }

    function _rejectedWithoutReserving(ScopedPaymaster p, bytes memory callData) internal {
        (, uint256 rejected) = p.validatePaymasterUserOp(_op(address(0xBEEF), callData), bytes32(0), 10);
        require(rejected == SIG_VALIDATION_FAILED, "out of scope");
        (, uint256 open) = p.validatePaymasterUserOp(
            _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678))),
            bytes32(0),
            10
        );
        require(open == 0, "failure must not reserve float");
    }

    function _sponsored(ScopedPaymaster p, bytes memory callData) internal {
        (bytes memory context, uint256 accepted) =
            p.validatePaymasterUserOp(_op(address(0xBEEF), callData), bytes32(0), 10);
        require(accepted == 0, "in scope");
        (, uint256 blocked) = p.validatePaymasterUserOp(
            _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678))),
            bytes32(0),
            10
        );
        require(blocked == SIG_VALIDATION_FAILED, "acceptance reserves float");
        p.postOp(IPaymaster.PostOpMode.opSucceeded, context, 4, 0);
        (, uint256 released) = p.validatePaymasterUserOp(
            _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678))),
            bytes32(0),
            6
        );
        require(released == 0, "postOp releases the unused reservation");
    }

    function _execute(address target, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SmartAccount.execute.selector, target, uint256(0), data);
    }

    function _batch(SmartAccount.Call[] memory calls) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SmartAccount.executeBatch.selector, calls);
    }

    function _session(address target, bytes memory data) internal pure returns (bytes memory) {
        address[] memory targets = new address[](1);
        targets[0] = address(0xA11CE);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = bytes4(0x12345678);
        SessionKeyLib.SessionSpec memory spec = SessionKeyLib.SessionSpec({
            key: address(0xCAFE),
            validAfter: 0,
            validUntil: 1,
            spendLimitWei: 0,
            targets: targets,
            selectors: selectors
        });
        return abi.encodeWithSelector(SmartAccount.executeWithSession.selector, spec, target, uint256(0), data);
    }

    function test_inner_execute_refuses_unallowlisted_target() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.execute.selector, true);
        _rejectedWithoutReserving(p, _execute(address(0xA11CE), abi.encodePacked(bytes4(0x12345678))));
    }

    function test_inner_execute_refuses_unpermitted_selector() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.execute.selector, true);
        p.setAllowlisted(address(0xA11CE), true);
        _rejectedWithoutReserving(p, _execute(address(0xA11CE), abi.encodePacked(bytes4(0xdeadbeef))));
    }

    function test_inner_execute_refuses_call_without_selector() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.execute.selector, true);
        p.setAllowlisted(address(0xA11CE), true);
        _rejectedWithoutReserving(p, _execute(address(0xA11CE), hex"123456"));
    }

    function test_inner_execute_refuses_short_wrapper() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.execute.selector, true);
        _rejectedWithoutReserving(p, abi.encodePacked(SmartAccount.execute.selector));
    }

    function test_inner_execute_refuses_undecodable_wrapper() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.execute.selector, true);
        bytes memory callData = abi.encodePacked(
            SmartAccount.execute.selector,
            abi.encode(address(0xA11CE), uint256(0), uint256(1000))
        );
        _rejectedWithoutReserving(p, callData);
    }

    function test_inner_execute_sponsors_allowlisted_target_and_permitted_selector() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.execute.selector, true);
        p.setAllowlisted(address(0xA11CE), true);
        _sponsored(p, _execute(address(0xA11CE), abi.encodeWithSelector(bytes4(0x12345678), uint256(1))));
    }

    function test_inner_execute_refuses_when_wrapper_selector_is_not_permitted() public {
        ScopedPaymaster p = _float();
        p.setAllowlisted(address(0xA11CE), true);
        _rejectedWithoutReserving(p, _execute(address(0xA11CE), abi.encodePacked(bytes4(0x12345678))));
    }

    function test_inner_empty_batch_refuses() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.executeBatch.selector, true);
        _rejectedWithoutReserving(p, _batch(new SmartAccount.Call[](0)));
    }

    function test_inner_batch_refuses_when_any_call_is_out_of_scope() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.executeBatch.selector, true);
        p.setAllowlisted(address(0xA11CE), true);
        SmartAccount.Call[] memory calls = new SmartAccount.Call[](2);
        calls[0] = SmartAccount.Call(address(0xA11CE), 0, abi.encodePacked(bytes4(0x12345678)));
        calls[1] = SmartAccount.Call(address(0xD00D), 0, abi.encodePacked(bytes4(0x12345678)));
        _rejectedWithoutReserving(p, _batch(calls));
    }

    function test_inner_batch_refuses_short_wrapper() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.executeBatch.selector, true);
        _rejectedWithoutReserving(p, abi.encodePacked(SmartAccount.executeBatch.selector, uint256(1)));
    }

    function test_inner_batch_sponsors_when_every_call_is_in_scope() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.executeBatch.selector, true);
        p.setSelector(bytes4(0x11111111), true);
        p.setAllowlisted(address(0xA11CE), true);
        p.setAllowlisted(address(0xD00D), true);
        SmartAccount.Call[] memory calls = new SmartAccount.Call[](2);
        calls[0] = SmartAccount.Call(address(0xA11CE), 0, abi.encodePacked(bytes4(0x12345678)));
        calls[1] = SmartAccount.Call(address(0xD00D), 0, abi.encodeWithSelector(bytes4(0x11111111), uint256(2)));
        _sponsored(p, _batch(calls));
    }

    function test_inner_session_refuses_unallowlisted_target() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.executeWithSession.selector, true);
        _rejectedWithoutReserving(p, _session(address(0xA11CE), abi.encodePacked(bytes4(0x12345678))));
    }

    function test_inner_session_refuses_unpermitted_selector() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.executeWithSession.selector, true);
        p.setAllowlisted(address(0xA11CE), true);
        _rejectedWithoutReserving(p, _session(address(0xA11CE), abi.encodePacked(bytes4(0xdeadbeef))));
    }

    function test_inner_session_refuses_short_wrapper() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.executeWithSession.selector, true);
        _rejectedWithoutReserving(p, abi.encodePacked(SmartAccount.executeWithSession.selector));
    }

    function test_inner_session_refuses_undecodable_wrapper() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.executeWithSession.selector, true);
        p.setAllowlisted(address(0xA11CE), true);
        bytes memory callData = abi.encodePacked(
            SmartAccount.executeWithSession.selector,
            uint256(0x400),
            uint256(uint160(address(0xA11CE))),
            uint256(0),
            uint256(0x400)
        );
        _rejectedWithoutReserving(p, callData);
    }

    function test_inner_session_sponsors_allowlisted_target_and_permitted_selector() public {
        ScopedPaymaster p = _float();
        p.setSelector(SmartAccount.executeWithSession.selector, true);
        p.setAllowlisted(address(0xA11CE), true);
        _sponsored(p, _session(address(0xA11CE), abi.encodePacked(bytes4(0x12345678))));
    }

    function test_inner_non_wrapper_still_sponsors_from_its_own_selector() public {
        ScopedPaymaster p = _float();
        _sponsored(p, abi.encodePacked(bytes4(0x12345678), bytes32(uint256(1))));
    }
}
