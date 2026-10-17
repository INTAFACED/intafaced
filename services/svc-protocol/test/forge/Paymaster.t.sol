// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation} from "../../contracts/interfaces/IAccount.sol";
import {IPaymaster} from "../../contracts/interfaces/IPaymaster.sol";
import {ScopedPaymaster} from "../../contracts/paymaster/ScopedPaymaster.sol";

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

    /// CHN-0020. Float 10 wei. Two user operations, each maxCost 8.
    /// Both are validated before either postOp. Each would fit the raw balance
    /// alone (8 <= 10). Together they do not (8 + 8 > 10), so the second fails.
    function test_chn0020_second_validation_fails_before_postOp() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        p.setAllowlisted(address(0xBEEF), true);
        p.setAllowlisted(address(0xCAFE), true);
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(8);
        (bool ok, ) = payable(p).call{value: 10}("");
        require(ok, "fund");
        PackedUserOperation memory firstOp = _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678)));
        PackedUserOperation memory secondOp = _op(address(0xCAFE), abi.encodePacked(bytes4(0x12345678)));

        (, uint256 first) = p.validatePaymasterUserOp(firstOp, bytes32(uint256(1)), 8);
        require(first == 0, "first op is sponsored");

        (, uint256 second) = p.validatePaymasterUserOp(secondOp, bytes32(uint256(2)), 8);
        require(second == SIG_VALIDATION_FAILED, "second op must not share the float");
        require(address(p).balance == 10, "float stays in the paymaster");
    }

    /// CHN-0020 failure. A lost bundler reply never reaches postOp.
    /// The open reservation still blocks a second sponsorship.
    function test_chn0020_lost_bundler_reply_does_not_sponsor_both() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        p.setAllowlisted(address(0xBEEF), true);
        p.setAllowlisted(address(0xCAFE), true);
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(8);
        (bool ok, ) = payable(p).call{value: 10}("");
        require(ok, "fund");
        PackedUserOperation memory firstOp = _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678)));
        PackedUserOperation memory retry = _op(address(0xCAFE), abi.encodePacked(bytes4(0x12345678)));

        (, uint256 first) = p.validatePaymasterUserOp(firstOp, bytes32(uint256(1)), 8);
        require(first == 0, "first op is sponsored");
        // Bundler reply lost: postOp is not called.

        (, uint256 second) = p.validatePaymasterUserOp(retry, bytes32(uint256(2)), 8);
        require(second == SIG_VALIDATION_FAILED, "lost reply must not sponsor both");
        require(address(p).balance == 10, "lost reply moves no float");
    }

    /// Re-applied from cf11ca401 (fix/L338-paymaster-reserve).
    /// postOp keeps the settled gas committed and releases only the unused reservation.
    function test_postOp_releases_unused_and_keeps_settled_gas() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        p.setAllowlisted(address(0xBEEF), true);
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(10);
        (bool ok, ) = payable(p).call{value: 10}("");
        require(ok, "fund");
        PackedUserOperation memory op = _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678)));

        (bytes memory context, uint256 first) = p.validatePaymasterUserOp(op, bytes32(0), 10);
        require(first == 0, "first op reserves the only maxCost");

        (, uint256 second) = p.validatePaymasterUserOp(op, bytes32(uint256(1)), 10);
        require(second == SIG_VALIDATION_FAILED, "second op must not share one float");

        p.postOp(IPaymaster.PostOpMode.opSucceeded, context, 4, 0);

        (, uint256 overUnused) = p.validatePaymasterUserOp(op, bytes32(uint256(2)), 7);
        require(overUnused == SIG_VALIDATION_FAILED, "settled gas stays committed");

        (, uint256 third) = p.validatePaymasterUserOp(op, bytes32(uint256(3)), 6);
        require(third == 0, "later op uses the released unused reservation");

        (, uint256 fourth) = p.validatePaymasterUserOp(op, bytes32(uint256(4)), 1);
        require(fourth == SIG_VALIDATION_FAILED, "released float is reserved again");
    }

    /// A second postOp for the same reservation must not release the settled gas again.
    function test_second_postOp_does_not_release_settled_gas() public {
        ScopedPaymaster p = new ScopedPaymaster(address(this), address(this));
        p.setAllowlisted(address(0xBEEF), true);
        p.setSelector(bytes4(0x12345678), true);
        p.setMaxCostWei(10);
        (bool ok, ) = payable(p).call{value: 10}("");
        require(ok, "fund");
        PackedUserOperation memory op = _op(address(0xBEEF), abi.encodePacked(bytes4(0x12345678)));

        (bytes memory context, uint256 first) = p.validatePaymasterUserOp(op, bytes32(0), 10);
        require(first == 0, "first op reserves the float");
        p.postOp(IPaymaster.PostOpMode.opSucceeded, context, 4, 0);

        bool releasedTwice = false;
        try p.postOp(IPaymaster.PostOpMode.opSucceeded, context, 4, 0) {
            releasedTwice = true;
        } catch {}
        require(!releasedTwice, "second postOp must revert");

        (, uint256 overSettled) = p.validatePaymasterUserOp(op, bytes32(uint256(1)), 7);
        require(overSettled == SIG_VALIDATION_FAILED, "settled 4 is not released by a second postOp");
        (, uint256 withinSettled) = p.validatePaymasterUserOp(op, bytes32(uint256(2)), 6);
        require(withinSettled == 0, "unused 6 stays available after one settlement");
    }
}
