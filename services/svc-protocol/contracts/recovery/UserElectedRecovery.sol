// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "../interfaces/IAccount.sol";

/**
 * USER-ELECTED RECOVERY — ERC-1271 owner a SmartAccount may set (`socket.social-recovery`).
 *
 * Doctrine (tracker + S-K7 ADR + board S-A1): the platform must NEVER be a guardian.
 * A guardian is a second party who can take the account. This contract has:
 *   · no admin, no operator, no pause, no upgrade
 *   · no hardcoded platform address and no platform quorum
 *   · guardians the USER elects (`addGuardian`) and can revoke (`removeGuardian`)
 *
 * The current `owner` of THIS contract (constructor `owner_`, later rotated by
 * recovery) is the only address that manages the guardian set and the M-of-N
 * threshold. Guardians may propose a new owner; after `delay` seconds AND M
 * distinct guardian calls (or ECDSA signatures over the recovery digest),
 * anyone may rotate `owner`. The sitting owner may `cancelRecovery` before that
 * rotation lands. An under-quorum proposal expires once `delay` has elapsed,
 * and a later `proposeRecovery` for a different owner replaces it. A proposal
 * that has reached the threshold cannot be replaced before `executeRecovery`.
 *
 * This contract answers ERC-1271 so a SmartAccount can set it as `owner` and
 * keep signing through the current recovery-owner (EOA or nested ERC-1271).
 * Residual: it is not wired as the default SmartAccount owner — the account
 * still starts with whatever key the factory was given.
 *
 * Not upgradeable. Lose every guardian and the owner key, lose this owner.
 */
contract UserElectedRecovery is IERC1271 {
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    bytes4 private constant ERC1271_FAIL = 0xffffffff;

    uint256 private constant SECP256K1_HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public owner;
    uint64 public immutable delay;
    uint64 public threshold;
    uint64 public guardianCount;

    mapping(address => bool) public isGuardian;

    uint64 public recoveryRound;
    address public pendingOwner;
    uint64 public proposedAt;
    uint64 public approvalCount;
    mapping(uint64 => mapping(address => bool)) public approved;

    event GuardianAdded(address indexed guardian);
    event GuardianRemoved(address indexed guardian);
    event ThresholdSet(uint64 threshold);
    event RecoveryProposed(address indexed guardian, address indexed newOwner, uint64 executeAfter);
    event RecoveryApproved(address indexed guardian, uint64 approvals);
    event RecoveryCancelled(address indexed owner, uint64 round);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotGuardian();
    error InvalidGuardian();
    error InvalidOwner();
    error AlreadyGuardian();
    error ThresholdTooHigh();
    error RecoveryUnavailable();
    error RecoveryInProgress();
    error NoRecovery();
    error NotPendingOwner();
    error AlreadyApproved();
    error DelayNotElapsed();
    error NotEnoughApprovals();
    error InvalidSignature();

    constructor(address owner_, uint64 delay_) {
        if (owner_ == address(0) || owner_ == address(this)) revert InvalidOwner();
        owner = owner_;
        delay = delay_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function addGuardian(address guardian) external onlyOwner {
        if (guardian == address(0) || guardian == address(this)) revert InvalidGuardian();
        if (isGuardian[guardian]) revert AlreadyGuardian();
        isGuardian[guardian] = true;
        unchecked {
            guardianCount += 1;
        }
        emit GuardianAdded(guardian);
    }

    function removeGuardian(address guardian) external onlyOwner {
        if (!isGuardian[guardian]) revert NotGuardian();
        isGuardian[guardian] = false;
        unchecked {
            guardianCount -= 1;
        }
        if (pendingOwner != address(0) && approved[recoveryRound][guardian]) {
            approved[recoveryRound][guardian] = false;
            unchecked {
                approvalCount -= 1;
            }
        }
        emit GuardianRemoved(guardian);
    }

    function setThreshold(uint64 threshold_) external onlyOwner {
        if (threshold_ > guardianCount) revert ThresholdTooHigh();
        threshold = threshold_;
        emit ThresholdSet(threshold_);
    }

    /**
     * A guardian starts (or joins) recovery toward `newOwner`. First proposer
     * opens the delay window; further calls from other guardians count as
     * approvals for the same pending owner. Once `delay` has elapsed, an
     * under-quorum proposal may be replaced by a different owner. A proposal
     * that has reached `threshold` cannot be replaced before `executeRecovery`.
     */
    function proposeRecovery(address newOwner) external {
        _requireLiveGuardian(msg.sender);
        _propose(newOwner, msg.sender);
    }

    /**
     * Count this guardian only for `newOwner`. A vote aimed at any other
     * address reverts and leaves `approvalCount` unchanged, so an in-flight
     * approval of an honest owner cannot be collected by a front-run
     * `proposeRecovery`.
     */
    function approveRecovery(address newOwner) external {
        _requireLiveGuardian(msg.sender);
        if (pendingOwner == address(0)) revert NoRecovery();
        if (newOwner != pendingOwner) revert NotPendingOwner();
        _approve(msg.sender);
    }

    /**
     * A guardian's ECDSA over `recoveryDigest()` may be submitted by anyone.
     * The digest binds `pendingOwner`, so the signature cannot be counted for
     * a different owner than the one pending when it was signed.
     */
    function approveRecoveryWithSignature(address guardian, bytes calldata signature) external {
        _requireLiveGuardian(guardian);
        if (pendingOwner == address(0)) revert NoRecovery();
        (address recovered, bool valid) = _tryRecover(recoveryDigest(), signature);
        if (!valid || recovered != guardian) revert InvalidSignature();
        _approve(guardian);
    }

    function executeRecovery() external {
        if (pendingOwner == address(0)) revert NoRecovery();
        if (!_recoveryQuorumPossible()) revert RecoveryUnavailable();
        if (approvalCount < threshold) revert NotEnoughApprovals();
        if (block.timestamp < uint256(proposedAt) + uint256(delay)) revert DelayNotElapsed();

        address previous = owner;
        address next = pendingOwner;
        _clearRecovery();
        owner = next;
        emit OwnerChanged(previous, next);
    }

    function cancelRecovery() external onlyOwner {
        if (pendingOwner == address(0)) revert NoRecovery();
        uint64 round = recoveryRound;
        _clearRecovery();
        emit RecoveryCancelled(msg.sender, round);
    }

    /**
     * Digest guardians sign for `approveRecoveryWithSignature`.
     * Bound to this contract, chain, round, and the pending owner so a
     * signature cannot be replayed onto a later recovery.
     */
    function recoveryDigest() public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, recoveryRound, pendingOwner));
    }

    /**
     * @param hash Digest the SmartAccount is validating (typically userOpHash).
     * @param signature 65-byte secp256k1 (r,s,v) if `owner` is an EOA; otherwise
     *        forwarded to the nested ERC-1271 owner (e.g. PasskeyOwner).
     */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        address current = owner;
        if (current.code.length > 0) {
            (bool ok, bytes memory returned) = current.staticcall(
                abi.encodeWithSelector(IERC1271.isValidSignature.selector, hash, signature)
            );
            return (ok && returned.length >= 32 && abi.decode(returned, (bytes4)) == ERC1271_MAGIC)
                ? ERC1271_MAGIC
                : ERC1271_FAIL;
        }
        (address recovered, bool valid) = _tryRecover(hash, signature);
        return (valid && recovered == current) ? ERC1271_MAGIC : ERC1271_FAIL;
    }

    function _propose(address newOwner, address guardian) private {
        if (newOwner == address(0) || newOwner == address(this)) revert InvalidOwner();
        if (!_recoveryQuorumPossible()) revert RecoveryUnavailable();

        // A different owner replaces this proposal only after `delay`, and only
        // while it is still under quorum. At threshold it stays until execute
        // or the sitting owner's cancel.
        if (pendingOwner != address(0) && pendingOwner != newOwner) {
            if (approvalCount >= threshold || block.timestamp < uint256(proposedAt) + uint256(delay)) {
                revert RecoveryInProgress();
            }
            _clearRecovery();
        }

        if (pendingOwner == address(0)) {
            unchecked {
                recoveryRound += 1;
            }
            pendingOwner = newOwner;
            proposedAt = uint64(block.timestamp);
            approvalCount = 0;
            emit RecoveryProposed(guardian, newOwner, proposedAt + delay);
        }

        _approve(guardian);
    }

    function _approve(address guardian) private {
        uint64 round = recoveryRound;
        if (approved[round][guardian]) revert AlreadyApproved();
        approved[round][guardian] = true;
        unchecked {
            approvalCount += 1;
        }
        emit RecoveryApproved(guardian, approvalCount);
    }

    function _requireLiveGuardian(address guardian) private view {
        if (!isGuardian[guardian]) revert NotGuardian();
    }

    function _recoveryQuorumPossible() private view returns (bool) {
        return threshold > 0 && guardianCount >= threshold;
    }

    function _clearRecovery() private {
        pendingOwner = address(0);
        proposedAt = 0;
        approvalCount = 0;
    }

    function _tryRecover(bytes32 digest, bytes calldata signature) private pure returns (address, bool) {
        if (signature.length != 65) return (address(0), false);

        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);

        if (uint256(s) > SECP256K1_HALF_N) return (address(0), false);
        if (v != 27 && v != 28) return (address(0), false);

        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) return (address(0), false);
        return (recovered, true);
    }
}
