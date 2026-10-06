// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * SESSION KEYS — scoped, expiring, non-custodial delegation (§17.4, §19).
 *
 * A session key is what lets an agent trade on a user's behalf under guardrails
 * without ever being able to move the user's funds out of the account. The
 * scope is not advisory: every field below is checked on-chain, on every call,
 * by SmartAccount.
 *
 * Doctrine §16.10 — "no contract grants platform keys withdrawal power over
 * user funds". A session key is the only thing the platform ever holds on this
 * plane, so the shape of a session key IS the custody boundary. Four properties
 * make it safe:
 *
 *   1. EXPIRY IS MANDATORY. `validUntil` must be in the future and no more than
 *      MAX_SESSION_DURATION away. There is no such thing as a permanent grant.
 *   2. TARGETS ARE AN EXACT ALLOWLIST, and can never include the account
 *      itself — so a session key can never grant itself more power, rotate the
 *      owner, or mint another session.
 *   3. SELECTORS ARE AN EXACT ALLOWLIST, and every selector that transfers a
 *      token or hands out an allowance is refused AT GRANT TIME. A session key
 *      with outbound-transfer power cannot be constructed. Not "is not issued" —
 *      cannot be constructed: `assertGrantable` reverts.
 *   4. NATIVE VALUE IS CAPPED cumulatively by `spendLimitWei`, counted before
 *      the external call, so re-entrancy cannot spend it twice.
 *
 * The user grants it. The user revokes it. The platform relays the transaction
 * and holds nothing else.
 */
library SessionKeyLib {
    /**
     * The full permission set. Stored on the account as a hash commitment and
     * re-presented on every call, so a session's scope is immutable for its
     * lifetime — a granted session cannot be silently widened.
     */
    struct SessionSpec {
        /** The delegated signer. Held by an agent, a device, or a bot. */
        address key;
        /** Not valid before this unix second. 0 = immediately. */
        uint48 validAfter;
        /** Hard expiry. Never 0, never further out than MAX_SESSION_DURATION. */
        uint48 validUntil;
        /** Cumulative cap on native value this session may ever move. */
        uint128 spendLimitWei;
        /** Exact contract addresses this session may call. Never the account. */
        address[] targets;
        /** Exact function selectors this session may invoke on those targets. */
        bytes4[] selectors;
    }

    /** No session may outlive this, whatever the user asks for. */
    uint48 internal constant MAX_SESSION_DURATION = 30 days;

    uint256 internal constant MAX_TARGETS = 32;
    uint256 internal constant MAX_SELECTORS = 32;

    // ── The refused selectors ────────────────────────────────────────────────
    //
    // Anything that moves a token out of the account, or hands someone else the
    // right to, is refused at grant time. A session key trades THROUGH an
    // allowlisted venue using an allowance the OWNER set; it never moves the
    // asset itself and never creates an allowance of its own.
    //
    // Selectors are hard-coded rather than derived so they are auditable by
    // eye, and services/svc-protocol/src/session/spec.ts asserts these exact
    // values from the function signatures. If the two ever disagree, the test
    // suite fails.

    bytes4 internal constant SEL_ERC20_TRANSFER = 0xa9059cbb;
    bytes4 internal constant SEL_ERC20_TRANSFER_FROM = 0x23b872dd;
    bytes4 internal constant SEL_ERC20_APPROVE = 0x095ea7b3;
    bytes4 internal constant SEL_ERC20_INCREASE_ALLOWANCE = 0x39509351;
    bytes4 internal constant SEL_ERC20_PERMIT = 0xd505accf;
    bytes4 internal constant SEL_ERC721_SET_APPROVAL_FOR_ALL = 0xa22cb465;
    bytes4 internal constant SEL_ERC721_SAFE_TRANSFER = 0x42842e0e;
    bytes4 internal constant SEL_ERC721_SAFE_TRANSFER_DATA = 0xb88d4fde;
    bytes4 internal constant SEL_ERC1155_SAFE_TRANSFER = 0xf242432a;
    bytes4 internal constant SEL_ERC1155_SAFE_BATCH_TRANSFER = 0x2eb2c2d6;
    bytes4 internal constant SEL_PERMIT2_APPROVE = 0x87517c45;
    bytes4 internal constant SEL_ERC777_SEND = 0x9bd9bbc6;
    bytes4 internal constant SEL_ERC777_OPERATOR_SEND = 0x62ad1b83;
    bytes4 internal constant SEL_ERC1363_TRANSFER_AND_CALL = 0x4000aea0;
    bytes4 internal constant SEL_ERC1363_APPROVE_AND_CALL = 0xcae9ca51;
    bytes4 internal constant SEL_ERC4626_WITHDRAW = 0xb460af94;
    bytes4 internal constant SEL_ERC4626_REDEEM = 0xba087652;
    bytes4 internal constant SEL_PERMIT2_TRANSFER_FROM = 0x36c78516;
    bytes4 internal constant SEL_TRANSFER_OWNERSHIP = 0xf2fde38b;
    bytes4 internal constant SEL_UPGRADE_TO = 0x3659cfe6;
    bytes4 internal constant SEL_UPGRADE_TO_AND_CALL = 0x4f1ef286;

    error SessionKeyRequired();
    error SessionExpiryRequired();
    error SessionExpiryInPast();
    error SessionDurationExceeded();
    error SessionTargetsRequired();
    error SessionTargetsTooMany();
    error SessionSelfTargetForbidden();
    error SessionZeroTargetForbidden();
    error SessionSelectorsRequired();
    error SessionSelectorsTooMany();
    error SessionFallbackSelectorForbidden();
    /** The one that matters: a session key may not be given transfer power. */
    error SessionOutboundTransferForbidden(bytes4 selector);

    /**
     * The commitment stored on the account.
     *
     * Full `abi.encode`, never packed: the TypeScript relay re-derives this hash
     * with viem's `encodeAbiParameters`, and packed encoding of dynamic arrays
     * is exactly the sort of thing that agrees on the happy path and diverges
     * on the one input that matters.
     */
    function hash(SessionSpec memory spec) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(spec.key, spec.validAfter, spec.validUntil, spec.spendLimitWei, spec.targets, spec.selectors)
            );
    }

    /**
     * Every rule that makes a session key safe, checked before it exists.
     *
     * `account` is the account granting the session — passed in so the
     * "a session may never call its own account" rule is enforced here rather
     * than being remembered at each call site.
     */
    function assertGrantable(SessionSpec memory spec, address account) internal view {
        if (spec.key == address(0)) revert SessionKeyRequired();

        if (spec.validUntil == 0) revert SessionExpiryRequired();
        if (spec.validUntil <= block.timestamp) revert SessionExpiryInPast();

        uint48 startsAt = spec.validAfter > uint48(block.timestamp) ? spec.validAfter : uint48(block.timestamp);
        // A window that closes before it opens is expiry-in-the-past by another
        // name. Checked explicitly rather than left to underflow, so the caller
        // gets a reason instead of a panic.
        if (spec.validUntil <= startsAt) revert SessionExpiryInPast();
        if (spec.validUntil - startsAt > MAX_SESSION_DURATION) revert SessionDurationExceeded();

        uint256 targetCount = spec.targets.length;
        if (targetCount == 0) revert SessionTargetsRequired();
        if (targetCount > MAX_TARGETS) revert SessionTargetsTooMany();

        for (uint256 i = 0; i < targetCount; i++) {
            address target = spec.targets[i];
            if (target == address(0)) revert SessionZeroTargetForbidden();
            // The rule that closes every escalation path at once. A session key
            // that cannot call the account cannot change the owner, cannot mint
            // itself a wider session, and cannot revoke the user's control.
            if (target == account) revert SessionSelfTargetForbidden();
        }

        uint256 selectorCount = spec.selectors.length;
        if (selectorCount == 0) revert SessionSelectorsRequired();
        if (selectorCount > MAX_SELECTORS) revert SessionSelectorsTooMany();

        for (uint256 i = 0; i < selectorCount; i++) {
            bytes4 selector = spec.selectors[i];
            // A zero selector is a raw call into a fallback — an unbounded hole
            // in an allowlist that is supposed to be exact.
            if (selector == bytes4(0)) revert SessionFallbackSelectorForbidden();
            if (isOutboundTransfer(selector)) revert SessionOutboundTransferForbidden(selector);
        }
    }

    /**
     * True for any selector that moves a token out of the account or grants
     * someone else the standing right to.
     *
     * Deliberately conservative. A false positive costs a user one venue
     * integration; a false negative costs a user their balance.
     */
    function isOutboundTransfer(bytes4 selector) internal pure returns (bool) {
        return
            selector == SEL_ERC20_TRANSFER ||
            selector == SEL_ERC20_TRANSFER_FROM ||
            selector == SEL_ERC20_APPROVE ||
            selector == SEL_ERC20_INCREASE_ALLOWANCE ||
            selector == SEL_ERC20_PERMIT ||
            selector == SEL_ERC721_SET_APPROVAL_FOR_ALL ||
            selector == SEL_ERC721_SAFE_TRANSFER ||
            selector == SEL_ERC721_SAFE_TRANSFER_DATA ||
            selector == SEL_ERC1155_SAFE_TRANSFER ||
            selector == SEL_ERC1155_SAFE_BATCH_TRANSFER ||
            selector == SEL_PERMIT2_APPROVE ||
            selector == SEL_ERC777_SEND ||
            selector == SEL_ERC777_OPERATOR_SEND ||
            selector == SEL_ERC1363_TRANSFER_AND_CALL ||
            selector == SEL_ERC1363_APPROVE_AND_CALL ||
            selector == SEL_ERC4626_WITHDRAW ||
            selector == SEL_ERC4626_REDEEM ||
            selector == SEL_PERMIT2_TRANSFER_FROM ||
            selector == SEL_TRANSFER_OWNERSHIP ||
            selector == SEL_UPGRADE_TO ||
            selector == SEL_UPGRADE_TO_AND_CALL;
    }

    function allowsTarget(SessionSpec memory spec, address target) internal pure returns (bool) {
        for (uint256 i = 0; i < spec.targets.length; i++) {
            if (spec.targets[i] == target) return true;
        }
        return false;
    }

    function allowsSelector(SessionSpec memory spec, bytes4 selector) internal pure returns (bool) {
        for (uint256 i = 0; i < spec.selectors.length; i++) {
            if (spec.selectors[i] == selector) return true;
        }
        return false;
    }
}
