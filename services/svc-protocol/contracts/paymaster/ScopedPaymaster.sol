// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PackedUserOperation} from "../interfaces/IAccount.sol";
import {IPaymaster} from "../interfaces/IPaymaster.sol";

/**
 * SCOPED PAYMASTER — S-A10 contract half (`socket.paymaster-policy`).
 *
 * Holds a native float and, when the EntryPoint asks, agrees to sponsor a
 * UserOp that the operator already allowlisted. This contract can spend ONLY
 * its own balance. It has no path to a user's SmartAccount, no pause that
 * freezes user funds, and no hardcoded platform address.
 *
 * A successful validation reserves `maxCost` from the unreserved float so a
 * second operation cannot pass against the same wei. `postOp` settles that
 * reservation to `actualGasCost` and releases the unused part. The float stays
 * in this contract: it is not deposited to, or withdrawn from, the EntryPoint.
 *
 * The first four bytes of `callData` are not always the sponsored call.
 * SmartAccount writes `execute`, `executeBatch`, or `executeWithSession`
 * there and puts the real target and selector later in the payload. Permitting
 * that wrapper does not sponsor the inner call: every inner target must be
 * allowlisted and every inner selector permitted. A short or undecodable
 * wrapper fails the same way and does not reserve float. Calldata that is
 * not one of those wrappers is still scoped by its own first four bytes.
 *
 * Funding the float is Nitro Class X (ADR 2026-08-08). Until ETH sits here,
 * every validation returns failure — same refuse as the TypeScript policy's
 * `funding_unconfigured`. An empty paymaster is not a pretend sponsor.
 *
 * The operator key can widen/narrow the allowlist and withdraw leftover float.
 * That key cannot move a user's tokens. Killing sponsorship does not kill
 * the user's account: they still submit with their own gas.
 */
contract ScopedPaymaster is IPaymaster {
    uint256 private constant SIG_VALIDATION_FAILED = 1;
    uint256 private constant SIG_VALIDATION_SUCCESS = 0;

    /// SmartAccount.execute(address,uint256,bytes)
    bytes4 private constant SEL_EXECUTE = bytes4(keccak256("execute(address,uint256,bytes)"));
    /// SmartAccount.executeBatch((address,uint256,bytes)[])
    bytes4 private constant SEL_EXECUTE_BATCH = bytes4(keccak256("executeBatch((address,uint256,bytes)[])"));
    /// SmartAccount.executeWithSession(SessionSpec,address,uint256,bytes)
    bytes4 private constant SEL_EXECUTE_WITH_SESSION = bytes4(
        keccak256("executeWithSession((address,uint48,uint48,uint128,address[],bytes4[]),address,uint256,bytes)")
    );
    /// Right-padding mask for an ABI `bytes4` word.
    uint256 private constant BYTES4_LOW_PAD = (uint256(1) << 224) - 1;

    address public immutable entryPoint;
    address public immutable operator;

    mapping(address => bool) public allowlisted;
    mapping(bytes4 => bool) public permittedSelector;
    uint256 public maxCostWei;
    /// Open `maxCost` locks plus gas already settled in `postOp`.
    uint256 private reservedWei;
    uint256 private nextReservation;
    mapping(uint256 => uint256) private reservationCost;
    mapping(uint256 => bool) private reservationOpen;

    error EntryPointRequired();
    error OperatorRequired();
    error NotEntryPoint();
    error NotOperator();
    error BadCap();

    event AllowlistSet(address indexed sender, bool allowed);
    event SelectorSet(bytes4 indexed selector, bool permitted);
    event MaxCostSet(uint256 maxCostWei);
    event FloatWithdrawn(address indexed to, uint256 amount);

    constructor(address entryPoint_, address operator_) {
        if (entryPoint_ == address(0)) revert EntryPointRequired();
        if (operator_ == address(0)) revert OperatorRequired();
        entryPoint = entryPoint_;
        operator = operator_;
    }

    receive() external payable {}

    function setAllowlisted(address sender, bool allowed) external {
        if (msg.sender != operator) revert NotOperator();
        if (sender == address(0)) revert OperatorRequired();
        allowlisted[sender] = allowed;
        emit AllowlistSet(sender, allowed);
    }

    function setSelector(bytes4 selector, bool permitted) external {
        if (msg.sender != operator) revert NotOperator();
        if (selector == bytes4(0)) revert BadCap();
        permittedSelector[selector] = permitted;
        emit SelectorSet(selector, permitted);
    }

    function setMaxCostWei(uint256 maxCostWei_) external {
        if (msg.sender != operator) revert NotOperator();
        maxCostWei = maxCostWei_;
        emit MaxCostSet(maxCostWei_);
    }

    /** Operator recovers unused float. Cannot touch a user's account. */
    function withdrawFloat(address to, uint256 amount) external {
        if (msg.sender != operator) revert NotOperator();
        if (to == address(0) || amount == 0) revert BadCap();
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert BadCap();
        emit FloatWithdrawn(to, amount);
    }

    /// Wei still free to sponsor: contract balance minus reserved and settled gas.
    function _unreservedFloat() internal view returns (uint256) {
        uint256 balance = address(this).balance;
        uint256 reserved = reservedWei;
        if (reserved >= balance) return 0;
        return balance - reserved;
    }

    function validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 /* userOpHash */,
        uint256 maxCost
    ) external override returns (bytes memory context, uint256 validationData) {
        if (msg.sender != entryPoint) revert NotEntryPoint();

        // Empty or already-reserved float refuses. Do not pretend to sponsor.
        uint256 available = _unreservedFloat();
        if (available == 0 || maxCost > available) {
            return ("", SIG_VALIDATION_FAILED);
        }
        if (maxCostWei == 0 || maxCost > maxCostWei) {
            return ("", SIG_VALIDATION_FAILED);
        }
        if (!allowlisted[userOp.sender]) {
            return ("", SIG_VALIDATION_FAILED);
        }
        if (userOp.callData.length < 4) {
            return ("", SIG_VALIDATION_FAILED);
        }
        bytes4 selector = bytes4(userOp.callData[0:4]);
        if (!permittedSelector[selector]) {
            return ("", SIG_VALIDATION_FAILED);
        }
        // A wrapper selector is the account entry, not the call being paid for.
        if (!_innerCallsInScope(selector, userOp.callData[4:])) {
            return ("", SIG_VALIDATION_FAILED);
        }
        uint256 id = nextReservation + 1;
        nextReservation = id;
        reservationOpen[id] = true;
        reservationCost[id] = maxCost;
        reservedWei = reservedWei + maxCost;
        context = abi.encode(id);
        validationData = SIG_VALIDATION_SUCCESS;
    }

    function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256) external override {
        if (msg.sender != entryPoint) revert NotEntryPoint();
        uint256 id = abi.decode(context, (uint256));
        if (!reservationOpen[id]) revert BadCap();
        uint256 reservedCost = reservationCost[id];
        if (actualGasCost > reservedCost) revert BadCap();
        reservationOpen[id] = false;
        // Keep actualGasCost committed. Release only the unused reservation.
        reservedWei = reservedWei - (reservedCost - actualGasCost);
    }

    /**
     * Non-wrappers were already accepted by their own selector.
     * Account execute wrappers must decode, and every inner call must name an
     * allowlisted target and a permitted selector. Anything short or
     * undecodable is out of scope. This returns false; it does not revert,
     * so a bad wrapper cannot reserve float.
     */
    function _innerCallsInScope(bytes4 selector, bytes calldata args) private view returns (bool) {
        if (selector == SEL_EXECUTE) return _callInScope(args, 0);
        if (selector == SEL_EXECUTE_BATCH) return _batchInScope(args);
        if (selector == SEL_EXECUTE_WITH_SESSION) return _sessionCallInScope(args);
        return true;
    }

    /// One ABI call: address, uint256 value, bytes data. `callAt` is the start of that tuple.
    function _callInScope(bytes calldata args, uint256 callAt) private view returns (bool) {
        if (callAt > args.length || args.length - callAt < 96) return false;
        (bool targetOk, address target) = _addressAt(args, callAt);
        if (!targetOk) return false;
        (bool valueOk, ) = _word(args, callAt + 32);
        if (!valueOk) return false;
        (bool offOk, uint256 dataOff) = _word(args, callAt + 64);
        if (!offOk || dataOff > args.length - callAt) return false;
        (bool selOk, bytes4 selector) = _bytesSelector(args, callAt + dataOff);
        if (!selOk) return false;
        return allowlisted[target] && permittedSelector[selector];
    }

    /// `executeBatch(Call[])`. An empty batch names no call.
    function _batchInScope(bytes calldata args) private view returns (bool) {
        (bool offOk, uint256 arrayOff) = _word(args, 0);
        if (!offOk || arrayOff > args.length || args.length - arrayOff < 32) return false;
        (bool lenOk, uint256 length) = _word(args, arrayOff);
        if (!lenOk || length == 0) return false;
        uint256 tupleAt = arrayOff + 32;
        if (tupleAt > args.length || length > (args.length - tupleAt) / 32) return false;
        for (uint256 i = 0; i < length; i++) {
            (bool callOk, uint256 callOff) = _word(args, tupleAt + i * 32);
            if (!callOk || callOff > args.length - tupleAt) return false;
            if (!_callInScope(args, tupleAt + callOff)) return false;
        }
        return true;
    }

    /// `executeWithSession(SessionSpec,address,uint256,bytes)`. The head holds the target and the data offset.
    function _sessionCallInScope(bytes calldata args) private view returns (bool) {
        if (args.length < 128) return false;
        (bool specOk, uint256 specOff) = _word(args, 0);
        if (!specOk || !_sessionSpecDecodes(args, specOff)) return false;
        (bool targetOk, address target) = _addressAt(args, 32);
        if (!targetOk) return false;
        (bool valueOk, ) = _word(args, 64);
        if (!valueOk) return false;
        (bool dataOk, uint256 dataOff) = _word(args, 96);
        if (!dataOk) return false;
        (bool selOk, bytes4 selector) = _bytesSelector(args, dataOff);
        if (!selOk) return false;
        return allowlisted[target] && permittedSelector[selector];
    }

    /// Bounds and ABI padding for SessionSpec. The fields themselves are not a sponsorship decision.
    function _sessionSpecDecodes(bytes calldata args, uint256 specOff) private pure returns (bool) {
        if (specOff > args.length || args.length - specOff < 192) return false;
        (bool keyOk, ) = _addressAt(args, specOff);
        if (!keyOk || !_fits(args, specOff + 32, 48) || !_fits(args, specOff + 64, 48) || !_fits(args, specOff + 96, 128)) {
            return false;
        }
        (bool targetsOk, uint256 targetsOff) = _word(args, specOff + 128);
        if (!targetsOk) return false;
        (bool selectorsOk, uint256 selectorsOff) = _word(args, specOff + 160);
        if (!selectorsOk) return false;
        return _addressArrayDecodes(args, specOff, targetsOff) && _bytes4ArrayDecodes(args, specOff, selectorsOff);
    }

    function _addressArrayDecodes(bytes calldata args, uint256 base, uint256 rel) private pure returns (bool) {
        (bool ok, uint256 abs) = _abs(args, base, rel);
        if (!ok) return false;
        (bool lenOk, uint256 length) = _word(args, abs);
        if (!lenOk) return false;
        if (length == 0) return true;
        uint256 start = abs + 32;
        if (start > args.length || length > (args.length - start) / 32) return false;
        for (uint256 i = 0; i < length; i++) {
            (bool addrOk, ) = _addressAt(args, start + i * 32);
            if (!addrOk) return false;
        }
        return true;
    }

    function _bytes4ArrayDecodes(bytes calldata args, uint256 base, uint256 rel) private pure returns (bool) {
        (bool ok, uint256 abs) = _abs(args, base, rel);
        if (!ok) return false;
        (bool lenOk, uint256 length) = _word(args, abs);
        if (!lenOk) return false;
        if (length == 0) return true;
        uint256 start = abs + 32;
        if (start > args.length || length > (args.length - start) / 32) return false;
        for (uint256 i = 0; i < length; i++) {
            (bool wordOk, uint256 word) = _word(args, start + i * 32);
            if (!wordOk || (word & BYTES4_LOW_PAD) != 0) return false;
        }
        return true;
    }

    function _abs(bytes calldata args, uint256 base, uint256 rel) private pure returns (bool ok, uint256 abs) {
        if (rel % 32 != 0 || base > args.length || rel > args.length - base) return (false, 0);
        return (true, base + rel);
    }

    function _bytesSelector(bytes calldata args, uint256 offset) private pure returns (bool ok, bytes4 selector) {
        (bool lenOk, uint256 length) = _word(args, offset);
        if (!lenOk || length < 4) return (false, bytes4(0));
        uint256 start = offset + 32;
        if (start > args.length || length > args.length - start) return (false, bytes4(0));
        selector = bytes4(args[start:start + 4]);
        ok = true;
    }

    function _addressAt(bytes calldata data, uint256 offset) private pure returns (bool ok, address account) {
        (bool wordOk, uint256 word) = _word(data, offset);
        if (!wordOk || word > type(uint160).max) return (false, address(0));
        return (true, address(uint160(word)));
    }

    function _fits(bytes calldata data, uint256 offset, uint256 bits) private pure returns (bool) {
        (bool ok, uint256 word) = _word(data, offset);
        return ok && word < (uint256(1) << bits);
    }

    function _word(bytes calldata data, uint256 offset) private pure returns (bool ok, uint256 value) {
        if (offset % 32 != 0 || data.length < 32 || offset > data.length - 32) return (false, 0);
        value = uint256(bytes32(data[offset:offset + 32]));
        ok = true;
    }
}
