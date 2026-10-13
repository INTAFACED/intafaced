// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAccount, IERC1271, PackedUserOperation} from "./interfaces/IAccount.sol";
import {SessionKeyLib} from "./SessionKeyLib.sol";

/**
 * SMART ACCOUNT — the user's keys, and only the user's keys (§17.4).
 *
 * An ERC-4337 v0.7 smart contract wallet. Deployed as an immutable EIP-1167
 * clone by AccountFactory, so its address is known before it exists and its
 * code can never change afterwards.
 *
 * ── What the platform can do with this contract ─────────────────────────────
 *   · relay a transaction the user already signed, and pay the gas for it
 *   · read state
 *   · hold a session key the user granted, inside the scope the user set
 *
 * ── What the platform cannot do, structurally ───────────────────────────────
 *   · there is no admin role, no operator role, no pause, no guardian
 *   · there is no upgrade path — an EIP-1167 clone delegates to one immutable
 *     implementation address baked into its own runtime code. Nobody, including
 *     us, can point it somewhere else. That is deliberate: an upgradeable
 *     account is a custodial account with extra steps
 *   · there is no function on this contract that an address other than `owner`
 *     can call to move value out. Session keys are refused transfer selectors
 *     at grant time (SessionKeyLib.assertGrantable) and can never target this
 *     account, so they cannot widen themselves
 *   · this contract cannot be destroyed, and holds no reference to any INTAFACED
 *     address at all
 *
 * The EntryPoint is the only privileged external address, it is `immutable`,
 * it is a public singleton we do not control, and its privilege is bounded to
 * "execute what the account's own signature validation just approved".
 *
 * Doctrine §16.9: sovereignty by architecture, not by policy. There is no
 * setting to change here, because there is nothing to set.
 *
 * ── §13 sockets ─────────────────────────────────────────────────────────────
 *   · SOCKET: passkey (P-256) owners. `owner` may be a contract, in which case
 *     signature validation goes through ERC-1271 — so a deployed `PasskeyOwner`
 *     (contracts/passkey/) is an owner without any change to this file.
 *     S-A9 / previously `socket.p256-verifier`.
 *   · SOCKET: social recovery (`socket.social-recovery`). Deliberately absent.
 *     A guardian set is a second party who can take the account, and the
 *     platform must never be one; the design needs its own review before any
 *     recovery path is added.
 */
contract SmartAccount is IAccount, IERC1271 {
    using SessionKeyLib for SessionKeyLib.SessionSpec;

    /** ERC-1271 magic value. */
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    /** ERC-4337 signature failure — a value, not a revert, per the spec. */
    uint256 private constant SIG_VALIDATION_FAILED = 1;
    uint256 private constant SIG_VALIDATION_SUCCESS = 0;

    /** Signature envelope modes. Byte 0 of `userOp.signature`. */
    uint8 private constant MODE_OWNER = 0x00;
    uint8 private constant MODE_SESSION = 0x01;

    /** secp256k1n / 2 — the upper half of the curve is refused as malleable. */
    uint256 private constant SECP256K1_HALF_N =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    /** The ERC-4337 EntryPoint. Immutable — there is no re-pointing this. */
    address public immutable entryPoint;

    /** The user. The only address with unrestricted power over this account. */
    address public owner;

    /** Two-step rotation, so a typo cannot strand an account forever. */
    address public pendingOwner;

    /**
     * Bumped by the owner to invalidate every outstanding session in one call,
     * and automatically on every ownership change. The user's panic button —
     * and the platform has no equivalent, by design.
     */
    uint64 public sessionEpoch;

    struct SessionRecord {
        /** Commitment to the full SessionSpec. Zero = no such session. */
        bytes32 specHash;
        uint48 validAfter;
        uint48 validUntil;
        /** Cumulative native value already moved under this session. */
        uint128 spentWei;
        uint64 epoch;
        bool revoked;
    }

    mapping(address sessionKey => SessionRecord) private _sessions;

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    event AccountInitialized(address indexed owner, address indexed entryPoint);
    event OwnerProposed(address indexed currentOwner, address indexed pendingOwner);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    /**
     * The full scope goes in the log, not just the commitment. It costs gas on a
     * rare call and it buys something worth having: the guardrails a user
     * granted are readable from the chain by anyone, with no access to our
     * calldata, our database, or us.
     */
    event SessionGranted(
        address indexed sessionKey,
        bytes32 specHash,
        uint48 validAfter,
        uint48 validUntil,
        uint128 spendLimitWei,
        address[] targets,
        bytes4[] selectors
    );
    event SessionRevoked(address indexed sessionKey, address indexed revokedBy);
    event SessionEpochBumped(uint64 previousEpoch, uint64 newEpoch);
    event SessionCallExecuted(address indexed sessionKey, address indexed target, bytes4 selector, uint256 value, uint128 spentWei);
    event Executed(address indexed target, uint256 value, bytes4 selector);

    error AlreadyInitialized();
    error OwnerRequired();
    error NotAuthorized();
    error NotEntryPoint();
    error NotPendingOwner();
    error UnknownSession();
    error SessionRevokedError();
    error SessionEpochStale();
    error SessionSpecMismatch();
    error SessionNotYetValid();
    error SessionExpired();
    error SessionTargetNotAllowed(address target);
    error SessionSelectorNotAllowed(bytes4 selector);
    error SessionCalldataTooShort();
    error SessionSpendLimitExceeded(uint256 attempted, uint256 limit);
    error SelfCallForbidden();
    error EntryPointRequired();
    error CallReverted(bytes reason);

    constructor(address entryPoint_) {
        if (entryPoint_ == address(0)) revert EntryPointRequired();
        entryPoint = entryPoint_;
        // Lock the implementation itself. Clones get their own storage and are
        // initialized by the factory; this only stops someone adopting the
        // template contract, which owns nothing but should own nothing forever.
        owner = address(1);
    }

    /** Called once by AccountFactory, in the same transaction as deployment. */
    function initialize(address newOwner) external {
        if (owner != address(0)) revert AlreadyInitialized();
        if (newOwner == address(0)) revert OwnerRequired();
        owner = newOwner;
        emit AccountInitialized(newOwner, entryPoint);
    }

    receive() external payable {}

    // ── ERC-4337 validation ─────────────────────────────────────────────────

    /**
     * The single place this account decides whether a user operation is the
     * user's will.
     *
     * The session branch is the important one. A session-signed operation is
     * only ever valid if its callData routes through `executeWithSession` —
     * which means every guardrail in that function is unavoidable. A session
     * key physically cannot reach `execute`, `grantSession`, `revokeSession`,
     * or `proposeOwner`, because validation refuses the operation before the
     * EntryPoint ever calls the account back.
     */
    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external override returns (uint256 validationData) {
        if (msg.sender != entryPoint) revert NotEntryPoint();

        validationData = _validateSignature(userOp, userOpHash);

        // Repay the bundler what the EntryPoint says is outstanding. This is the
        // only outbound native value this contract moves without an explicit
        // instruction, it is bounded by the EntryPoint's own accounting, and it
        // happens after validation so a failed signature still pays for the
        // gas the bundler already burned (as the spec requires).
        if (missingAccountFunds != 0) {
            (bool ok, ) = payable(msg.sender).call{value: missingAccountFunds}("");
            ok; // EntryPoint reverts on shortfall; nothing useful to do here.
        }
    }

    function _validateSignature(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    ) private view returns (uint256) {
        bytes calldata signature = userOp.signature;
        if (signature.length < 2) return SIG_VALIDATION_FAILED;

        uint8 mode = uint8(signature[0]);
        bytes calldata payload = signature[1:];
        bytes32 digest = _toEthSignedMessageHash(userOpHash);

        if (mode == MODE_OWNER) {
            return _isValidOwnerSignature(digest, payload) ? SIG_VALIDATION_SUCCESS : SIG_VALIDATION_FAILED;
        }

        if (mode != MODE_SESSION) return SIG_VALIDATION_FAILED;

        (address signer, bool ok) = _tryRecover(digest, payload);
        if (!ok) return SIG_VALIDATION_FAILED;

        SessionRecord storage record = _sessions[signer];
        if (record.specHash == bytes32(0) || record.revoked || record.epoch != sessionEpoch) {
            return SIG_VALIDATION_FAILED;
        }

        // Force the session through the guarded entry.
        if (userOp.callData.length < 4) return SIG_VALIDATION_FAILED;
        if (bytes4(userOp.callData[0:4]) != this.executeWithSession.selector) return SIG_VALIDATION_FAILED;

        (SessionKeyLib.SessionSpec memory spec, , , ) = abi.decode(
            userOp.callData[4:],
            (SessionKeyLib.SessionSpec, address, uint256, bytes)
        );
        if (spec.key != signer) return SIG_VALIDATION_FAILED;

        // Hand the expiry to the EntryPoint as well, so a stale operation is
        // rejected before it reaches us.
        return (uint256(record.validAfter) << 208) | (uint256(record.validUntil) << 160);
    }

    /** ERC-1271. Owner signatures only — a session key is never a valid signer here. */
    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        // A session key that could produce a valid ERC-1271 signature could sign
        // an off-chain permit and empty the account without ever calling it.
        // That is precisely the hole this contract exists to close.
        return _isValidOwnerSignature(hash, signature) ? ERC1271_MAGIC : bytes4(0xffffffff);
    }

    // ── Execution ───────────────────────────────────────────────────────────

    /**
     * Unrestricted execution. Reachable only by the owner — directly, or through
     * an EntryPoint operation whose signature validation matched the owner.
     */
    function execute(address target, uint256 value, bytes calldata data) external returns (bytes memory result) {
        _requireOwnerAuthorized();
        result = _call(target, value, data);
        emit Executed(target, value, data.length >= 4 ? bytes4(data[0:4]) : bytes4(0));
    }

    function executeBatch(Call[] calldata calls) external returns (bytes[] memory results) {
        _requireOwnerAuthorized();
        results = new bytes[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            results[i] = _call(calls[i].target, calls[i].value, calls[i].data);
            bytes calldata data = calls[i].data;
            emit Executed(calls[i].target, calls[i].value, data.length >= 4 ? bytes4(data[0:4]) : bytes4(0));
        }
    }

    /**
     * Execution under a session key. Every guardrail lives here, and this is
     * the only function a session key can reach.
     */
    function executeWithSession(
        SessionKeyLib.SessionSpec calldata spec,
        address target,
        uint256 value,
        bytes calldata data
    ) external returns (bytes memory result) {
        // Either the EntryPoint (whose validation already proved the signer is
        // spec.key) or the session key calling this account directly.
        if (msg.sender != entryPoint && msg.sender != spec.key) revert NotAuthorized();

        SessionRecord storage record = _sessions[spec.key];
        if (record.specHash == bytes32(0)) revert UnknownSession();
        if (record.revoked) revert SessionRevokedError();
        if (record.epoch != sessionEpoch) revert SessionEpochStale();
        if (record.specHash != SessionKeyLib.hash(spec)) revert SessionSpecMismatch();

        if (block.timestamp < spec.validAfter) revert SessionNotYetValid();
        if (block.timestamp >= spec.validUntil) revert SessionExpired();

        if (target == address(this)) revert SelfCallForbidden();
        if (!SessionKeyLib.allowsTarget(spec, target)) revert SessionTargetNotAllowed(target);

        // A bare native transfer has no selector to allowlist, so it is not a
        // scoped call — it is a payment, and a session key does not make those.
        if (data.length < 4) revert SessionCalldataTooShort();
        bytes4 selector = bytes4(data[0:4]);
        if (!SessionKeyLib.allowsSelector(spec, selector)) revert SessionSelectorNotAllowed(selector);
        // Re-checked at call time as well as grant time. Cheap, and it means a
        // stored spec can never outlive a change to what counts as a transfer.
        if (SessionKeyLib.isOutboundTransfer(selector)) {
            revert SessionKeyLib.SessionOutboundTransferForbidden(selector);
        }
        // A trade made by a session is made FOR this account: where the call names
        // a recipient, it must be this account. The owner's token allowance pays
        // for the trade; it must not pay a stranger.
        SessionKeyLib.assertRecipientIsAccount(selector, data, address(this));

        // Counted BEFORE the external call, so re-entrancy spends the budget
        // once rather than once per re-entry.
        uint256 attempted = uint256(record.spentWei) + value;
        if (attempted > spec.spendLimitWei) revert SessionSpendLimitExceeded(attempted, spec.spendLimitWei);
        record.spentWei = uint128(attempted);

        result = _call(target, value, data);
        emit SessionCallExecuted(spec.key, target, selector, value, record.spentWei);
    }

    // ── Session lifecycle (owner only) ──────────────────────────────────────

    /**
     * Grant a scoped session. Only the owner can do this, and the grant is
     * checked before it exists — a session key with transfer power reverts here
     * rather than being stored and hoped about later.
     */
    function grantSession(SessionKeyLib.SessionSpec calldata spec) external {
        _requireOwnerAuthorized();
        SessionKeyLib.SessionSpec memory copy = spec;
        SessionKeyLib.assertGrantable(copy, address(this));

        _sessions[spec.key] = SessionRecord({
            specHash: SessionKeyLib.hash(copy),
            validAfter: spec.validAfter,
            validUntil: spec.validUntil,
            // Re-granting a key resets its budget. That is the point of a
            // re-grant, and the owner is the only one who can do it.
            spentWei: 0,
            epoch: sessionEpoch,
            revoked: false
        });

        emit SessionGranted(
            spec.key,
            _sessions[spec.key].specHash,
            spec.validAfter,
            spec.validUntil,
            spec.spendLimitWei,
            spec.targets,
            spec.selectors
        );
    }

    /** Revocable by the owner, or by the session key retiring itself. Nobody else. */
    function revokeSession(address sessionKey) external {
        if (msg.sender != owner && msg.sender != address(this) && msg.sender != entryPoint && msg.sender != sessionKey) {
            revert NotAuthorized();
        }
        SessionRecord storage record = _sessions[sessionKey];
        if (record.specHash == bytes32(0)) revert UnknownSession();
        record.revoked = true;
        emit SessionRevoked(sessionKey, msg.sender);
    }

    /** Kill every outstanding session at once. Owner only. */
    function bumpSessionEpoch() external {
        _requireOwnerAuthorized();
        uint64 previous = sessionEpoch;
        sessionEpoch = previous + 1;
        emit SessionEpochBumped(previous, sessionEpoch);
    }

    function getSession(address sessionKey) external view returns (SessionRecord memory) {
        return _sessions[sessionKey];
    }

    /** True only if this key can act right now, under the current epoch. */
    function isSessionLive(address sessionKey) external view returns (bool) {
        SessionRecord storage record = _sessions[sessionKey];
        return
            record.specHash != bytes32(0) &&
            !record.revoked &&
            record.epoch == sessionEpoch &&
            block.timestamp >= record.validAfter &&
            block.timestamp < record.validUntil;
    }

    // ── Ownership (two-step) ────────────────────────────────────────────────

    function proposeOwner(address newOwner) external {
        _requireOwnerAuthorized();
        if (newOwner == address(0)) revert OwnerRequired();
        pendingOwner = newOwner;
        emit OwnerProposed(owner, newOwner);
    }

    /**
     * Accepted by the incoming key itself, which proves it exists and can sign
     * before it becomes the only thing standing between the user and their
     * funds. Every outstanding session dies with the old owner.
     */
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        uint64 previousEpoch = sessionEpoch;
        sessionEpoch = previousEpoch + 1;
        emit OwnerChanged(previous, msg.sender);
        emit SessionEpochBumped(previousEpoch, sessionEpoch);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    /**
     * The owner, the account acting on its own behalf, or the EntryPoint.
     *
     * The EntryPoint is only here because validation already ran: a session-key
     * operation cannot reach any caller of this function, because
     * `_validateSignature` refuses any session operation whose callData is not
     * `executeWithSession`.
     */
    function _requireOwnerAuthorized() private view {
        if (msg.sender != owner && msg.sender != address(this) && msg.sender != entryPoint) revert NotAuthorized();
    }

    function _call(address target, uint256 value, bytes calldata data) private returns (bytes memory) {
        (bool ok, bytes memory returned) = target.call{value: value}(data);
        if (!ok) revert CallReverted(returned);
        return returned;
    }

    function _isValidOwnerSignature(bytes32 digest, bytes calldata signature) private view returns (bool) {
        address currentOwner = owner;
        // A contract owner is how a passkey owns this account: the P-256
        // verifier answers ERC-1271 and the account never learns a secp256k1
        // address at all.
        if (currentOwner.code.length > 0) {
            (bool ok, bytes memory returned) = currentOwner.staticcall(
                abi.encodeWithSelector(IERC1271.isValidSignature.selector, digest, signature)
            );
            return ok && returned.length >= 32 && abi.decode(returned, (bytes4)) == ERC1271_MAGIC;
        }
        (address recovered, bool valid) = _tryRecover(digest, signature);
        return valid && recovered == currentOwner;
    }

    /** ECDSA with the malleability half of the curve refused outright. */
    function _tryRecover(bytes32 digest, bytes calldata signature) private pure returns (address, bool) {
        if (signature.length != 65) return (address(0), false);

        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);

        // secp256k1n / 2. Above this, (r, -s) is an equally valid signature for
        // the same key, so accepting it would let the same authorisation appear
        // twice with two different hashes.
        if (uint256(s) > SECP256K1_HALF_N) {
            return (address(0), false);
        }
        if (v != 27 && v != 28) return (address(0), false);

        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) return (address(0), false);
        return (recovered, true);
    }

    function _toEthSignedMessageHash(bytes32 hash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }
}
