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
 *   5. OUTPUT GOES HOME. A selector that names a recipient (a swap's `to`, an
 *      LP mint/burn `to`) may only be called with the granting account as that
 *      recipient. A session key trades FOR the account; it cannot route the
 *      proceeds of a trade to anyone else, even when the owner's token
 *      allowance is what pays for it. See `recipientOffset`. Where the called
 *      contract also trusts an address argument (the router's pool), that
 *      address must be one of the session's own targets. See `targetArgOffset`.
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
    //
    // Protocol calls that pay out, redirect an entitlement, or hand over control
    // through an address (or a struct holding one) the caller names and this
    // library cannot bind to the account. Refused outright for a session; the
    // owner key does these. Reasons, by group:
    //   escrow open/lock/release/dispute (dispute starts the clock after which
    //     settleTimeout can pay the buyer, i.e. release by another route),
    //     market buy/bid: spend or release the account's
    //     tokens against terms the caller chooses (price, quote token, fee recipient)
    //   market list/startAuction: escrow the account's NFT against a caller-chosen
    //     quote token and price
    //   crew approveSpend, legacy setHeirs, recovery guardian/owner calls, card
    //     setSettlement, paymaster withdrawFloat: redirect funds or control
    //   meme launch, token factory create: the recipient / token / quote addresses
    //     sit inside a struct with dynamic fields, and a fake pair token lets the
    //     caller drain the quote side
    bytes4 internal constant SEL_ESCROW_OPEN = 0x492284ae; // open(address,address,uint128,address,address,uint16,uint32,uint8)
    bytes4 internal constant SEL_LOCK = 0xdd467064; // lock(uint256)
    bytes4 internal constant SEL_ESCROW_RELEASE = 0x37bdc99b; // release(uint256)
    bytes4 internal constant SEL_ESCROW_DISPUTE = 0x86d6282c; // dispute(uint256)
    bytes4 internal constant SEL_CREW_APPROVE_SPEND = 0xad453b6f; // approveSpend(uint256)
    bytes4 internal constant SEL_LEGACY_SET_HEIRS = 0xe520d104; // setHeirs(address[],uint16[])
    bytes4 internal constant SEL_MARKET_LIST = 0xea8cdb1f; // list(address,uint256,address,uint256)
    bytes4 internal constant SEL_MARKET_START_AUCTION = 0xea51b9e1; // startAuction(address,uint256,address,uint256,uint32)
    bytes4 internal constant SEL_MARKET_BUY = 0xd96a094a; // buy(uint256)
    bytes4 internal constant SEL_MARKET_BID = 0x598647f8; // bid(uint256,uint256)
    bytes4 internal constant SEL_MEME_LAUNCH = 0x4223ede2; // launch((address,string,string,uint8,uint256,address,uint16,uint256,uint256,uint64,bytes32))
    bytes4 internal constant SEL_TOKEN_FACTORY_CREATE = 0x30af4ba0; // createToken(bytes32,(string,string,uint8,uint256,address))
    bytes4 internal constant SEL_RECOVERY_ADD_GUARDIAN = 0xa526d83b; // addGuardian(address)
    bytes4 internal constant SEL_RECOVERY_REMOVE_GUARDIAN = 0x71404156; // removeGuardian(address)
    bytes4 internal constant SEL_RECOVERY_PROPOSE = 0x7ee76082; // proposeRecovery(address)
    bytes4 internal constant SEL_RECOVERY_APPROVE_WITH_SIG = 0x2c6b732a; // approveRecoveryWithSignature(address,bytes)
    bytes4 internal constant SEL_RECOVERY_SET_THRESHOLD = 0x17c4de35; // setThreshold(uint64)
    bytes4 internal constant SEL_CARD_SET_SETTLEMENT = 0x8f4e6f37; // setSettlement(address)
    bytes4 internal constant SEL_PAYMASTER_WITHDRAW_FLOAT = 0xf9bf1347; // withdrawFloat(address,uint256)

    // ── The recipient-bearing selectors ──────────────────────────────────────
    //
    // Calls a session MAY be allowlisted for, whose calldata names who receives
    // the output. For each, the recipient argument must be the account itself.
    //
    //   pool    swapExactIn(address tokenIn,uint256,uint256,address to)  arg 3
    //   router  swapExactIn(address pool,address tokenIn,uint256,uint256,address to)  arg 4
    //   pool    swap(uint256,uint256,address to)                         arg 2
    //   pool    mint(address to,uint256,uint256)                         arg 0
    //   pool    burn(address to,uint256)                                 arg 0
    //   vault   proposeSpend(address to,uint256)                         arg 0
    //   nft     setTokenRoyalty(uint256,address receiver,uint16)         arg 1
    //
    // The TypeScript mirror (`RECIPIENT_SCOPED_CALLS` in session/spec.ts) lists
    // the same signatures and argument positions; spec.test.ts asserts every
    // selector and offset below against it, and against the compiled ABIs.

    bytes4 internal constant SEL_POOL_SWAP_EXACT_IN = 0xa6220b66;
    bytes4 internal constant SEL_ROUTER_SWAP_EXACT_IN = 0x7b32b50e;
    bytes4 internal constant SEL_POOL_SWAP = 0x6d9a640a;
    bytes4 internal constant SEL_POOL_MINT = 0x156e29f6;
    bytes4 internal constant SEL_POOL_BURN = 0x9dc29fac;
    bytes4 internal constant SEL_VAULT_PROPOSE_SPEND = 0x20a1440a;
    bytes4 internal constant SEL_NFT_SET_TOKEN_ROYALTY = 0x78db6c53;

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
    /** The call's recipient word is not the granting account (right-aligned, clean high bytes). */
    error SessionRecipientNotAccount(bytes4 selector, bytes32 recipientWord);
    /** The call's calldata ends before its recipient word does. */
    error SessionRecipientCalldataTooShort(bytes4 selector);
    /** An address argument the contract trusts (the router's pool) is not one of the session's targets. */
    error SessionTargetArgNotAllowed(bytes4 selector, bytes32 argWord);
    /** The call's calldata ends before its trusted-address word does. */
    error SessionTargetArgCalldataTooShort(bytes4 selector);

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
            selector == SEL_ESCROW_OPEN ||
            selector == SEL_LOCK ||
            selector == SEL_ESCROW_RELEASE ||
            selector == SEL_ESCROW_DISPUTE ||
            selector == SEL_CREW_APPROVE_SPEND ||
            selector == SEL_LEGACY_SET_HEIRS ||
            selector == SEL_MARKET_LIST ||
            selector == SEL_MARKET_START_AUCTION ||
            selector == SEL_MARKET_BUY ||
            selector == SEL_MARKET_BID ||
            selector == SEL_MEME_LAUNCH ||
            selector == SEL_TOKEN_FACTORY_CREATE ||
            selector == SEL_RECOVERY_ADD_GUARDIAN ||
            selector == SEL_RECOVERY_REMOVE_GUARDIAN ||
            selector == SEL_RECOVERY_PROPOSE ||
            selector == SEL_RECOVERY_APPROVE_WITH_SIG ||
            selector == SEL_RECOVERY_SET_THRESHOLD ||
            selector == SEL_CARD_SET_SETTLEMENT ||
            selector == SEL_PAYMASTER_WITHDRAW_FLOAT ||
            selector == SEL_UPGRADE_TO_AND_CALL;
    }

    /**
     * Byte offset, within calldata, of the recipient word of a recipient-bearing
     * selector (4 + 32 * argument index). 0 means the selector names no recipient
     * that this library constrains.
     */
    function recipientOffset(bytes4 selector) internal pure returns (uint256) {
        if (selector == SEL_POOL_SWAP_EXACT_IN) return 100;
        if (selector == SEL_ROUTER_SWAP_EXACT_IN) return 132;
        if (selector == SEL_POOL_SWAP) return 68;
        if (selector == SEL_POOL_MINT) return 4;
        if (selector == SEL_POOL_BURN) return 4;
        if (selector == SEL_VAULT_PROPOSE_SPEND) return 4;
        if (selector == SEL_NFT_SET_TOKEN_ROYALTY) return 36;
        return 0;
    }

    /**
     * For a recipient-bearing selector, require the recipient to be `account`.
     *
     * The comparison is on the whole 32-byte word against the account
     * left-padded with zeros, with no decoding: a word with dirty high bytes is
     * refused rather than truncated, so there is nothing for the TypeScript
     * mirror to decode differently. Calldata that ends before the word is
     * refused, never read as zero. Selectors that are not recipient-bearing pass.
     */
    function assertRecipientIsAccount(bytes4 selector, bytes calldata data, address account) internal pure {
        uint256 offset = recipientOffset(selector);
        if (offset == 0) return;
        if (data.length < offset + 32) revert SessionRecipientCalldataTooShort(selector);
        bytes32 word = bytes32(data[offset:offset + 32]);
        if (word != bytes32(uint256(uint160(account)))) revert SessionRecipientNotAccount(selector, word);
    }

    /**
     * Byte offset of an address argument that the called contract TRUSTS (reads
     * token0/token1 and amountOut from it, or sends the account's tokens to it).
     * A recipient check alone does not protect against it: the router's `pool`
     * argument can be an attacker's contract that takes the account's approved
     * tokens while `to` is the account. For these selectors the argument must be
     * one of the session's own targets, i.e. a contract the owner chose to
     * trust. 0 means the selector has no such argument.
     */
    function targetArgOffset(bytes4 selector) internal pure returns (uint256) {
        if (selector == SEL_ROUTER_SWAP_EXACT_IN) return 4;
        return 0;
    }

    /**
     * For a selector with a trusted-address argument, require that argument to be
     * in `spec.targets`. Same raw-word rule as the recipient: no decoding, dirty
     * high bytes refused, calldata that ends early refused.
     */
    function assertTargetArgAllowed(SessionSpec memory spec, bytes4 selector, bytes calldata data) internal pure {
        uint256 offset = targetArgOffset(selector);
        if (offset == 0) return;
        if (data.length < offset + 32) revert SessionTargetArgCalldataTooShort(selector);
        bytes32 word = bytes32(data[offset:offset + 32]);
        if (uint256(word) >> 160 != 0 || !allowsTarget(spec, address(uint160(uint256(word))))) {
            revert SessionTargetArgNotAllowed(selector, word);
        }
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
