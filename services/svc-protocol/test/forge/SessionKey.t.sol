// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccountFactory} from "../../contracts/AccountFactory.sol";
import {PackedUserOperation} from "../../contracts/interfaces/IAccount.sol";
import {SessionKeyLib} from "../../contracts/SessionKeyLib.sol";
import {SmartAccount} from "../../contracts/SmartAccount.sol";

/// Foundry cheatcodes without vendoring forge-std (no submodule).
interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function deal(address who, uint256 amount) external;
}

Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

/// Wraps SessionKeyLib internals so fuzz tests can call them.
contract SessionKeyLibHarness {
    function grantable(SessionKeyLib.SessionSpec memory spec, address account) external view {
        SessionKeyLib.assertGrantable(spec, account);
    }

    function outbound(bytes4 selector) external pure returns (bool) {
        return SessionKeyLib.isOutboundTransfer(selector);
    }

    function recipientOffset(bytes4 selector) external pure returns (uint256) {
        return SessionKeyLib.recipientOffset(selector);
    }

    function targetArg(SessionKeyLib.SessionSpec memory spec, bytes4 selector, bytes calldata data) external pure {
        SessionKeyLib.assertTargetArgAllowed(spec, selector, data);
    }

    function targetArgOffset(bytes4 selector) external pure returns (uint256) {
        return SessionKeyLib.targetArgOffset(selector);
    }

    function recipient(bytes4 selector, bytes calldata data, address account) external pure {
        SessionKeyLib.assertRecipientIsAccount(selector, data, account);
    }
}

/// Stands in for a pool / router / vault: accepts any call and counts it.
contract SessionCallSink {
    uint256 public calls;

    fallback() external payable {
        calls++;
    }

    receive() external payable {}
}

/**
 * Session key that is also the call target. `ping` tries to spend again and
 * swallows the revert so a pre-count of spendLimit is the only thing that
 * stops a second native transfer in the same transaction.
 */
contract SessionReenter {
    SmartAccount public immutable account;
    uint48 public validAfter;
    uint48 public validUntil;
    uint128 public spendLimitWei;
    address public target;
    bytes4 public selector;

    constructor(SmartAccount account_) {
        account = account_;
    }

    function configure(uint48 validAfter_, uint48 validUntil_, uint128 limit, address target_, bytes4 selector_)
        external
    {
        validAfter = validAfter_;
        validUntil = validUntil_;
        spendLimitWei = limit;
        target = target_;
        selector = selector_;
    }

    function spec() public view returns (SessionKeyLib.SessionSpec memory s) {
        s.key = address(this);
        s.validAfter = validAfter;
        s.validUntil = validUntil;
        s.spendLimitWei = spendLimitWei;
        s.targets = new address[](1);
        s.targets[0] = target;
        s.selectors = new bytes4[](1);
        s.selectors[0] = selector;
    }

    function ping() external payable {
        try account.executeWithSession(spec(), address(this), 1 ether, abi.encodeWithSelector(this.ping.selector)) {}
        catch {}
    }

    function attack(uint256 value) external {
        account.executeWithSession(spec(), address(this), value, abi.encodeWithSelector(this.ping.selector));
    }

    receive() external payable {}
}

/// S-A8: session-key escalation, spend-limit re-entrancy, validateUserOp gate.
contract SessionKeyForgeTest {
    uint256 internal constant SESSION_PRIV = 0xA11CE;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    SessionKeyLibHarness internal harness;

    constructor() {
        harness = new SessionKeyLibHarness();
    }

    function _forbiddenSelectors() internal pure returns (bytes4[33] memory s) {
        s[0] = 0xa9059cbb;
        s[1] = 0x23b872dd;
        s[2] = 0x095ea7b3;
        s[3] = 0x39509351;
        s[4] = 0xd505accf;
        s[5] = 0xa22cb465;
        s[6] = 0x42842e0e;
        s[7] = 0xb88d4fde;
        s[8] = 0xf242432a;
        s[9] = 0x2eb2c2d6;
        s[10] = 0x87517c45;
        s[11] = 0xf2fde38b;
        s[12] = 0x3659cfe6;
        s[13] = 0x4f1ef286;
        s[14] = 0x492284ae;
        s[15] = 0xdd467064;
        s[16] = 0x37bdc99b;
        s[17] = 0xd96a094a;
        s[18] = 0x598647f8;
        s[19] = 0xea8cdb1f;
        s[20] = 0xea51b9e1;
        s[21] = 0xad453b6f;
        s[22] = 0xe520d104;
        s[23] = 0xa526d83b;
        s[24] = 0x71404156;
        s[25] = 0x7ee76082;
        s[26] = 0x2c6b732a;
        s[27] = 0x17c4de35;
        s[28] = 0x8f4e6f37;
        s[29] = 0xf9bf1347;
        s[30] = 0x4223ede2;
        s[31] = 0x30af4ba0;
        s[32] = 0x86d6282c; // SovereignEscrow.dispute(uint256)
    }

    function _legalSpec(address key, address target) internal view returns (SessionKeyLib.SessionSpec memory spec) {
        spec.key = key;
        spec.validAfter = 0;
        spec.validUntil = uint48(block.timestamp + 1 days);
        spec.spendLimitWei = 1 ether;
        spec.targets = new address[](1);
        spec.targets[0] = target;
        spec.selectors = new bytes4[](1);
        spec.selectors[0] = bytes4(keccak256("swap(uint256,uint256)"));
    }

    function _deployClone() internal returns (SmartAccount account) {
        // This test contract is the EntryPoint so it can call validateUserOp.
        SmartAccount impl = new SmartAccount(address(this));
        AccountFactory factory = new AccountFactory(address(impl));
        account = SmartAccount(payable(factory.createAccount(address(this), bytes32(uint256(1)))));
    }

    function _sessionEnvelope(uint256 priv, bytes32 userOpHash) internal returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", userOpHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(priv, digest);
        return abi.encodePacked(bytes1(0x01), r, s, v);
    }

    function _blankOp(address sender, bytes memory callData, bytes memory signature)
        internal
        pure
        returns (PackedUserOperation memory op)
    {
        op.sender = sender;
        op.callData = callData;
        op.signature = signature;
    }

    // ── assertGrantable: self-target ─────────────────────────────────────────

    function test_self_target_refused() public view {
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(this));
        spec.targets[0] = address(this);
        try harness.grantable(spec, address(this)) {
            revert("self target must revert");
        } catch {}
    }

    function testFuzz_self_target_refused(address account, address other) public view {
        if (account == address(0)) return;
        if (other == address(0) || other == account) other = address(uint160(uint256(keccak256(abi.encode(account)))));
        if (other == address(0) || other == account) return;

        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), other);
        spec.targets[0] = account;
        try harness.grantable(spec, account) {
            revert("self target must revert");
        } catch {}
    }

    function testFuzz_self_target_in_list_refused(uint8 idx, address other) public view {
        address account = address(this);
        if (other == address(0) || other == account) other = address(0xBEEF);
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), other);
        spec.targets = new address[](2);
        spec.targets[0] = other;
        spec.targets[1] = address(0xCAFE);
        spec.targets[idx % 2] = account;
        try harness.grantable(spec, account) {
            revert("any self target must revert");
        } catch {}
    }

    // ── assertGrantable: outbound selectors ──────────────────────────────────

    function test_every_hardcoded_outbound_selector_refused() public view {
        bytes4[33] memory forbidden = _forbiddenSelectors();
        for (uint256 i = 0; i < forbidden.length; i++) {
            SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
            spec.selectors[0] = forbidden[i];
            try harness.grantable(spec, address(this)) {
                revert("outbound selector must revert");
            } catch {}
        }
    }

    /// ERC-777 send/operatorSend, ERC-1363 transferAndCall/approveAndCall,
    /// ERC-4626 withdraw/redeem, and Permit2 transferFrom move funds and
    /// must be refused at grant time.
    function test_missed_fund_selectors_are_outbound_and_not_grantable() public view {
        bytes4[7] memory missed;
        missed[0] = 0x9bd9bbc6; // ERC-777 send(address,uint256,bytes)
        missed[1] = 0x62ad1b83; // ERC-777 operatorSend
        missed[2] = 0x4000aea0; // ERC-1363 transferAndCall(address,uint256,bytes)
        missed[3] = 0xcae9ca51; // ERC-1363 approveAndCall(address,uint256,bytes)
        missed[4] = 0xb460af94; // ERC-4626 withdraw
        missed[5] = 0xba087652; // ERC-4626 redeem
        missed[6] = 0x36c78516; // Permit2 transferFrom(address,address,uint160,address)
        for (uint256 i = 0; i < missed.length; i++) {
            require(harness.outbound(missed[i]), "missed selector is not an outbound fund move");
            SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
            spec.selectors[0] = missed[i];
            try harness.grantable(spec, address(this)) {
                revert("missed fund selector must not be grantable");
            } catch {}
        }
    }

    function testFuzz_outbound_selector_refused(uint8 which) public view {
        bytes4[33] memory forbidden = _forbiddenSelectors();
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
        spec.selectors[0] = forbidden[which % 33];
        try harness.grantable(spec, address(this)) {
            revert("outbound selector must revert");
        } catch {}
    }

    function testFuzz_selector_matches_outbound_predicate(bytes4 selector) public view {
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
        spec.selectors[0] = selector;
        bool out = harness.outbound(selector);
        try harness.grantable(spec, address(this)) {
            require(selector != bytes4(0), "zero selector granted");
            require(!out, "outbound selector granted");
        } catch {
            require(selector == bytes4(0) || out, "legal selector refused");
        }
    }

    function test_legal_spec_grants() public view {
        harness.grantable(_legalSpec(address(0xBEEF), address(0xCAFE)), address(this));
    }

    // ── clone path: grant refuses self-target / transfer ─────────────────────

    function test_clone_grant_refuses_self_target() public {
        SmartAccount account = _deployClone();
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(account));
        try account.grantSession(spec) {
            revert("clone self target must revert");
        } catch {}
    }

    function test_clone_grant_refuses_transfer() public {
        SmartAccount account = _deployClone();
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
        spec.selectors[0] = 0xa9059cbb;
        try account.grantSession(spec) {
            revert("clone transfer selector must revert");
        } catch {}
    }

    // ── spend-limit counted before _call ─────────────────────────────────────

    function test_spend_limit_reentrancy_cannot_double_spend() public {
        SmartAccount account = _deployClone();
        SessionReenter reenter = new SessionReenter(account);
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(reenter), address(reenter));
        spec.selectors[0] = SessionReenter.ping.selector;
        spec.spendLimitWei = 1 ether;
        reenter.configure(spec.validAfter, spec.validUntil, spec.spendLimitWei, address(reenter), spec.selectors[0]);

        account.grantSession(spec);
        vm.deal(address(account), 2 ether);

        reenter.attack(1 ether);

        require(address(reenter).balance == 1 ether, "reentrancy spent twice");
        require(address(account).balance == 1 ether, "account drained");
        require(account.getSession(address(reenter)).spentWei == 1 ether, "spent counter");
    }

    function testFuzz_spend_over_limit_reverts(uint64 over) public {
        uint128 limit = 1 ether;
        uint256 value = uint256(limit) + uint256(over) + 1;
        SmartAccount account = _deployClone();
        SessionReenter reenter = new SessionReenter(account);
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(reenter), address(reenter));
        spec.selectors[0] = SessionReenter.ping.selector;
        spec.spendLimitWei = limit;
        reenter.configure(spec.validAfter, spec.validUntil, spec.spendLimitWei, address(reenter), spec.selectors[0]);
        account.grantSession(spec);
        vm.deal(address(account), value + 1 ether);
        try reenter.attack(value) {
            revert("over-limit must revert");
        } catch {}
        require(address(account).balance == value + 1 ether, "failed spend must not move value");
    }

    // ── validateUserOp: session ops must be executeWithSession ───────────────

    function test_validateUserOp_session_refuses_execute() public {
        SmartAccount account = _deployClone();
        address sessionKey = vm.addr(SESSION_PRIV);
        SessionKeyLib.SessionSpec memory spec = _legalSpec(sessionKey, address(0xCAFE));
        account.grantSession(spec);

        bytes memory executeCall = abi.encodeWithSelector(SmartAccount.execute.selector, address(0xCAFE), uint256(0), bytes(""));
        bytes32 userOpHash = keccak256("session-execute");
        PackedUserOperation memory op = _blankOp(address(account), executeCall, _sessionEnvelope(SESSION_PRIV, userOpHash));

        uint256 data = account.validateUserOp(op, userOpHash, 0);
        require(data == SIG_VALIDATION_FAILED, "session execute must fail validation");
    }

    function test_validateUserOp_session_refuses_grantSession() public {
        SmartAccount account = _deployClone();
        address sessionKey = vm.addr(SESSION_PRIV);
        SessionKeyLib.SessionSpec memory spec = _legalSpec(sessionKey, address(0xCAFE));
        account.grantSession(spec);

        bytes memory grantCall = abi.encodeWithSelector(SmartAccount.grantSession.selector, spec);
        bytes32 userOpHash = keccak256("session-grant");
        PackedUserOperation memory op = _blankOp(address(account), grantCall, _sessionEnvelope(SESSION_PRIV, userOpHash));

        uint256 data = account.validateUserOp(op, userOpHash, 0);
        require(data == SIG_VALIDATION_FAILED, "session grantSession must fail validation");
    }

    function test_validateUserOp_session_accepts_executeWithSession() public {
        SmartAccount account = _deployClone();
        address sessionKey = vm.addr(SESSION_PRIV);
        SessionKeyLib.SessionSpec memory spec = _legalSpec(sessionKey, address(0xCAFE));
        account.grantSession(spec);

        bytes memory guarded = abi.encodeWithSelector(
            SmartAccount.executeWithSession.selector,
            spec,
            address(0xCAFE),
            uint256(0),
            abi.encodeWithSelector(bytes4(keccak256("swap(uint256,uint256)")), uint256(1), uint256(2))
        );
        bytes32 userOpHash = keccak256("session-guarded");
        PackedUserOperation memory op = _blankOp(address(account), guarded, _sessionEnvelope(SESSION_PRIV, userOpHash));

        uint256 data = account.validateUserOp(op, userOpHash, 0);
        require(data != SIG_VALIDATION_FAILED, "guarded session op must validate");
        require(uint160(data) == 0, "authorizer must be zero on success");
        require(uint256(uint48(data >> 160)) == spec.validUntil, "validUntil packed");
        require(uint256(uint48(data >> 208)) == spec.validAfter, "validAfter packed");
    }

    function testFuzz_validateUserOp_session_refuses_foreign_selector(bytes4 selector) public {
        if (selector == SmartAccount.executeWithSession.selector) return;
        SmartAccount account = _deployClone();
        address sessionKey = vm.addr(SESSION_PRIV);
        SessionKeyLib.SessionSpec memory spec = _legalSpec(sessionKey, address(0xCAFE));
        account.grantSession(spec);

        bytes memory callData = abi.encodePacked(selector, uint256(0));
        bytes32 userOpHash = keccak256(abi.encode(selector));
        PackedUserOperation memory op = _blankOp(address(account), callData, _sessionEnvelope(SESSION_PRIV, userOpHash));

        uint256 data = account.validateUserOp(op, userOpHash, 0);
        require(data == SIG_VALIDATION_FAILED, "non-guarded selector must fail");
    }

    function test_grantSession_gas_ceiling() public {
        SmartAccount account = _deployClone();
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
        uint256 start = gasleft();
        account.grantSession(spec);
        uint256 used = start - gasleft();
        require(used < 250_000, "grantSession gas drifted");
    }

    // ── recipient scope: output goes to the granting account ─────────────────
    //
    // The test contract is the EntryPoint, the owner AND the session key, so it
    // can grant a session and then call `executeWithSession` as that key.

    bytes4 internal constant POOL_SWAP_EXACT_IN = 0xa6220b66; // swapExactIn(address,uint256,uint256,address)
    bytes4 internal constant ROUTER_SWAP_EXACT_IN = 0x7b32b50e; // swapExactIn(address,address,uint256,uint256,address)

    function _recipientSetup(bytes4 selector)
        internal
        returns (SmartAccount account, SessionCallSink sink, SessionKeyLib.SessionSpec memory spec)
    {
        account = _deployClone();
        sink = new SessionCallSink();
        spec = _legalSpec(address(this), address(sink));
        spec.spendLimitWei = 0;
        spec.selectors[0] = selector;
        account.grantSession(spec);
    }

    function _poolSwap(address to) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(POOL_SWAP_EXACT_IN, address(0x3333), uint256(1_000_000_000), uint256(0), to);
    }

    function _routerSwap(address pool, address to) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            ROUTER_SWAP_EXACT_IN, pool, address(0x3333), uint256(1_000_000_000), uint256(0), to
        );
    }

    /// Reverts the test unless `data` is refused with exactly `errorSelector`.
    function _expectRefusal(SmartAccount account, SessionKeyLib.SessionSpec memory spec, address target, bytes memory data, bytes4 errorSelector, string memory why)
        internal
    {
        try account.executeWithSession(spec, target, 0, data) {
            revert(why);
        } catch (bytes memory err) {
            require(err.length >= 4 && bytes4(err) == errorSelector, "refused for the wrong reason");
        }
    }

    function test_pool_swap_to_stranger_reverts() public {
        (SmartAccount account, SessionCallSink sink, SessionKeyLib.SessionSpec memory spec) =
            _recipientSetup(POOL_SWAP_EXACT_IN);
        _expectRefusal(
            account, spec, address(sink), _poolSwap(address(0x4444)), SessionKeyLib.SessionRecipientNotAccount.selector,
            "swap to a stranger must revert"
        );
        require(sink.calls() == 0, "refused call must not reach the pool");
    }

    function test_pool_swap_to_own_account_passes() public {
        (SmartAccount account, SessionCallSink sink, SessionKeyLib.SessionSpec memory spec) =
            _recipientSetup(POOL_SWAP_EXACT_IN);
        account.executeWithSession(spec, address(sink), 0, _poolSwap(address(account)));
        require(sink.calls() == 1, "swap to own account must reach the pool");
    }

    function test_router_swap_to_stranger_reverts_and_to_account_passes() public {
        (SmartAccount account, SessionCallSink sink, SessionKeyLib.SessionSpec memory spec) =
            _recipientSetup(ROUTER_SWAP_EXACT_IN);
        _expectRefusal(
            account, spec, address(sink), _routerSwap(address(sink), address(0x4444)), SessionKeyLib.SessionRecipientNotAccount.selector,
            "router swap to a stranger must revert"
        );
        // The router's first two args are addresses too; the account in the pool slot is not the recipient.
        _expectRefusal(
            account,
            spec,
            address(sink),
            abi.encodeWithSelector(
                ROUTER_SWAP_EXACT_IN, address(account), address(account), uint256(1), uint256(0), address(0x4444)
            ),
            SessionKeyLib.SessionRecipientNotAccount.selector,
            "account in a non-recipient slot must not satisfy the rule"
        );
        require(sink.calls() == 0, "refused calls must not reach the router");
        account.executeWithSession(spec, address(sink), 0, _routerSwap(address(sink), address(account)));
        require(sink.calls() == 1, "router swap to own account must pass");
    }

    function test_short_calldata_reverts_not_allowed() public {
        (SmartAccount account, SessionCallSink sink, SessionKeyLib.SessionSpec memory spec) =
            _recipientSetup(POOL_SWAP_EXACT_IN);
        bytes memory full = _poolSwap(address(account));
        // Selector only, then every length up to one byte short of the end of the recipient word.
        for (uint256 len = 4; len < full.length; len++) {
            bytes memory cut = new bytes(len);
            for (uint256 i = 0; i < len; i++) cut[i] = full[i];
            _expectRefusal(
                account, spec, address(sink), cut, SessionKeyLib.SessionRecipientCalldataTooShort.selector,
                "truncated calldata must revert"
            );
        }
        require(sink.calls() == 0, "truncated calls must not reach the pool");
        // Exactly the end of the recipient word is enough.
        account.executeWithSession(spec, address(sink), 0, full);
        require(sink.calls() == 1, "full-length call must pass");
    }

    function test_dirty_high_bytes_in_recipient_word_revert() public {
        (SmartAccount account, SessionCallSink sink, SessionKeyLib.SessionSpec memory spec) =
            _recipientSetup(POOL_SWAP_EXACT_IN);
        bytes memory data = abi.encodePacked(
            POOL_SWAP_EXACT_IN,
            uint256(uint160(address(0x3333))),
            uint256(1),
            uint256(0),
            bytes12(0xff0000000000000000000000),
            address(account)
        );
        _expectRefusal(
            account, spec, address(sink), data, SessionKeyLib.SessionRecipientNotAccount.selector,
            "dirty recipient word must revert"
        );
    }

    function test_unconstrained_selector_is_unaffected() public {
        (SmartAccount account, SessionCallSink sink, SessionKeyLib.SessionSpec memory spec) =
            _recipientSetup(bytes4(keccak256("placeOrder(address,bool,uint256,uint256)")));
        // A selector with no recipient argument passes, even with nothing after the selector.
        account.executeWithSession(spec, address(sink), 0, abi.encodePacked(spec.selectors[0]));
        require(sink.calls() == 1, "unconstrained selector must pass");
    }

    function test_recipientOffset_table() public view {
        require(harness.recipientOffset(0xa6220b66) == 100, "pool swapExactIn");
        require(harness.recipientOffset(0x7b32b50e) == 132, "router swapExactIn");
        require(harness.recipientOffset(0x6d9a640a) == 68, "pool swap");
        require(harness.recipientOffset(0x156e29f6) == 4, "pool mint");
        require(harness.recipientOffset(0x9dc29fac) == 4, "pool burn");
        require(harness.recipientOffset(0x20a1440a) == 4, "vault proposeSpend");
        require(harness.recipientOffset(0x78db6c53) == 36, "nft setTokenRoyalty");
        require(harness.recipientOffset(bytes4(0)) == 0, "zero selector names no recipient");
        require(harness.targetArgOffset(ROUTER_SWAP_EXACT_IN) == 4, "router pool arg");
        require(harness.targetArgOffset(POOL_SWAP_EXACT_IN) == 0, "pool swapExactIn trusts no argument");
    }

    function testFuzz_foreign_recipient_refused(address account, address recipient) public view {
        if (recipient == account) return;
        bytes memory data = abi.encodeWithSelector(
            POOL_SWAP_EXACT_IN, address(0x3333), uint256(1), uint256(0), recipient
        );
        try harness.recipient(POOL_SWAP_EXACT_IN, data, account) {
            revert("foreign recipient must revert");
        } catch {}
    }

    function testFuzz_own_recipient_passes(address account, uint256 a, uint256 b) public view {
        bytes memory data = abi.encodeWithSelector(ROUTER_SWAP_EXACT_IN, address(0x2222), address(0x3333), a, b, account);
        harness.recipient(ROUTER_SWAP_EXACT_IN, data, account);
    }

    function testFuzz_truncated_calldata_refused(uint8 cutBy, address account) public view {
        bytes memory full = _routerSwap(address(0x2222), account);
        uint256 len = full.length - 1 - (uint256(cutBy) % (full.length - 4 - 1));
        bytes memory cut = new bytes(len);
        for (uint256 i = 0; i < len; i++) cut[i] = full[i];
        try harness.recipient(ROUTER_SWAP_EXACT_IN, cut, account) {
            revert("truncated calldata must revert");
        } catch {}
    }

    // ── router pool argument must be one of the session's targets ─────────────

    function test_router_swap_with_pool_outside_targets_reverts() public {
        (SmartAccount account, SessionCallSink sink, SessionKeyLib.SessionSpec memory spec) =
            _recipientSetup(ROUTER_SWAP_EXACT_IN);
        // Recipient is the account, so the recipient rule passes; the pool is not a target.
        _expectRefusal(
            account, spec, address(sink), _routerSwap(address(0xBAD1), address(account)),
            SessionKeyLib.SessionTargetArgNotAllowed.selector, "pool outside targets must revert"
        );
        require(sink.calls() == 0, "refused call must not reach the router");
    }

    function test_router_pool_word_with_dirty_high_bytes_reverts() public {
        (SmartAccount account, SessionCallSink sink, SessionKeyLib.SessionSpec memory spec) =
            _recipientSetup(ROUTER_SWAP_EXACT_IN);
        bytes memory data = abi.encodePacked(
            ROUTER_SWAP_EXACT_IN,
            bytes12(0xff0000000000000000000000),
            address(sink),
            uint256(uint160(address(0x3333))),
            uint256(1),
            uint256(0),
            uint256(uint160(address(account)))
        );
        _expectRefusal(
            account, spec, address(sink), data, SessionKeyLib.SessionTargetArgNotAllowed.selector,
            "dirty pool word must revert"
        );
    }

    function testFuzz_target_arg_outside_targets_refused(address pool) public view {
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
        if (pool == address(0xCAFE)) return;
        bytes memory data = _routerSwap(pool, address(0x1));
        try harness.targetArg(spec, ROUTER_SWAP_EXACT_IN, data) {
            revert("pool outside targets must revert");
        } catch (bytes memory err) {
            require(bytes4(err) == SessionKeyLib.SessionTargetArgNotAllowed.selector, "wrong error");
        }
    }

    function testFuzz_target_arg_short_calldata_refused(uint8 len) public view {
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
        bytes memory full = _routerSwap(address(0xCAFE), address(0x1));
        uint256 n = uint256(len) % 36; // 0..35: ends before the pool word does
        bytes memory cut = new bytes(n);
        for (uint256 i = 0; i < n; i++) cut[i] = full[i];
        try harness.targetArg(spec, ROUTER_SWAP_EXACT_IN, cut) {
            revert("short calldata must revert");
        } catch (bytes memory err) {
            require(bytes4(err) == SessionKeyLib.SessionTargetArgCalldataTooShort.selector, "wrong error");
        }
    }

    // ── payout selectors added to the forbidden set ──────────────────────────

    function test_payout_selectors_refused_at_grant_and_clone() public {
        bytes4[8] memory sels = [
            bytes4(0x492284ae), // escrow open
            bytes4(0xdd467064), // lock(uint256)
            bytes4(0x37bdc99b), // escrow release
            bytes4(0x86d6282c), // escrow dispute
            bytes4(0xad453b6f), // crew approveSpend
            bytes4(0xe520d104), // legacy setHeirs
            bytes4(0xea8cdb1f), // market list
            bytes4(0x4223ede2) // meme launch
        ];
        SmartAccount account = _deployClone();
        for (uint256 i = 0; i < sels.length; i++) {
            SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
            spec.selectors[0] = sels[i];
            require(harness.outbound(sels[i]), "must count as outbound");
            try account.grantSession(spec) {
                revert("payout selector must not be grantable");
            } catch {}
        }
    }
}
