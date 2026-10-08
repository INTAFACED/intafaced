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

/// Records who a venue call pays. A session must not be able to name anyone but the account.
contract SessionPayoutVenue {
    address public paid;

    function clear() external {
        paid = address(0);
    }

    function swapExactTokensForTokens(uint256, uint256, address[] calldata, address to, uint256) external returns (uint256) {
        paid = to;
        return 1;
    }

    function execute(bytes calldata, bytes[] calldata inputs, uint256) external returns (address recipient) {
        (, recipient, ) = abi.decode(inputs[0], (address, address, uint256));
        paid = recipient;
    }

    function other(uint256) external pure returns (uint256) {
        return 7;
    }
}

/// Native sink for a session call. Payable so the spend cap is the only limit.
contract SessionGasSink {
    function hold() external payable {}
}

/// S-A8: session-key escalation, spend-limit re-entrancy, validateUserOp gate.
contract SessionKeyForgeTest {
    uint256 internal constant SESSION_PRIV = 0xA11CE;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;

    SessionKeyLibHarness internal harness;

    constructor() {
        harness = new SessionKeyLibHarness();
    }

    function _forbiddenSelectors() internal pure returns (bytes4[14] memory s) {
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

    function _sessionExecuteOp(
        SmartAccount account,
        SessionKeyLib.SessionSpec memory spec,
        address target,
        uint256 value,
        bytes32 userOpHash
    ) internal returns (PackedUserOperation memory) {
        bytes memory guarded = abi.encodeWithSelector(
            SmartAccount.executeWithSession.selector,
            spec,
            target,
            value,
            abi.encodeWithSelector(SessionGasSink.hold.selector)
        );
        return _blankOp(address(account), guarded, _sessionEnvelope(SESSION_PRIV, userOpHash));
    }

    function _selector(bytes memory reason) internal pure returns (bytes4 sel) {
        require(reason.length >= 4, "revert data");
        assembly {
            sel := mload(add(reason, 32))
        }
    }

    receive() external payable {}

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
        bytes4[14] memory forbidden = _forbiddenSelectors();
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
        bytes4[14] memory forbidden = _forbiddenSelectors();
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
        spec.selectors[0] = forbidden[which % 14];
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

    function test_validateUserOp_session_gas_over_spend_limit_does_not_pay() public {
        SmartAccount account = _deployClone();
        SessionGasSink sink = new SessionGasSink();
        address sessionKey = vm.addr(SESSION_PRIV);
        SessionKeyLib.SessionSpec memory spec = _legalSpec(sessionKey, address(sink));
        spec.selectors[0] = SessionGasSink.hold.selector;
        account.grantSession(spec);

        uint256 grant = spec.spendLimitWei;
        uint256 over = grant + 1;
        vm.deal(address(account), grant * 3);
        uint256 accountBefore = address(account).balance;
        uint256 entryBefore = address(this).balance;

        PackedUserOperation memory op = _sessionExecuteOp(account, spec, address(sink), 0, keccak256("session-gas-over-grant"));
        try account.validateUserOp(op, keccak256("session-gas-over-grant"), over) {
            revert("gas above the stored grant must revert");
        } catch (bytes memory reason) {
            require(_selector(reason) == SmartAccount.SessionSpendLimitExceeded.selector, "stored grant");
        }
        require(address(account).balance == accountBefore, "over-grant gas moved account eth");
        require(address(this).balance == entryBefore, "over-grant gas paid the entry point");
        require(account.getSession(sessionKey).spentWei == 0, "over-grant gas counted");

        SessionKeyLib.SessionSpec memory inflated = _legalSpec(sessionKey, address(sink));
        inflated.selectors[0] = SessionGasSink.hold.selector;
        inflated.spendLimitWei = spec.spendLimitWei * 2;
        op = _sessionExecuteOp(account, inflated, address(sink), 0, keccak256("session-gas-inflated-grant"));
        try account.validateUserOp(op, keccak256("session-gas-inflated-grant"), over) {
            revert("calldata spend limit must not raise the stored grant");
        } catch (bytes memory reason) {
            require(_selector(reason) == SmartAccount.SessionSpecMismatch.selector, "stored spec");
        }
        require(address(account).balance == accountBefore, "inflated grant moved account eth");
        require(address(this).balance == entryBefore, "inflated grant paid the entry point");
        require(account.getSession(sessionKey).spentWei == 0, "inflated grant counted");

        _assertExactStoredGrantPays(account, sink, spec, grant);
    }

    /// Equality with the stored grant is still inside it. A second draw is not.
    function _assertExactStoredGrantPays(
        SmartAccount account,
        SessionGasSink sink,
        SessionKeyLib.SessionSpec memory spec,
        uint256 grant
    ) internal {
        uint256 accountBefore = address(account).balance;
        uint256 entryBefore = address(this).balance;
        bytes32 payHash = keccak256("session-gas-exact-grant");
        uint256 data = account.validateUserOp(_sessionExecuteOp(account, spec, address(sink), 0, payHash), payHash, grant);
        require(data != SIG_VALIDATION_FAILED, "gas equal to the stored grant must validate");
        require(address(account).balance == accountBefore - grant, "exact grant left the account");
        require(address(this).balance == entryBefore + grant, "entry point received the exact grant");
        require(account.getSession(spec.key).spentWei == grant, "exact grant counted");
        _assertSecondGrantDrawRefused(account, sink, spec, grant);
    }

    function _assertSecondGrantDrawRefused(
        SmartAccount account,
        SessionGasSink sink,
        SessionKeyLib.SessionSpec memory spec,
        uint256 grant
    ) internal {
        uint256 accountBefore = address(account).balance;
        uint256 entryBefore = address(this).balance;
        bytes32 again = keccak256("session-gas-after-exact-grant");
        try account.validateUserOp(_sessionExecuteOp(account, spec, address(sink), 0, again), again, grant) {
            revert("a second grant of gas must revert");
        } catch (bytes memory reason) {
            require(_selector(reason) == SmartAccount.SessionSpendLimitExceeded.selector, "grant already used");
        }
        require(address(account).balance == accountBefore, "second gas payment moved account eth");
        require(address(this).balance == entryBefore, "second gas payment reached the entry point");
        require(account.getSession(spec.key).spentWei == grant, "second gas payment counted");
    }

    function test_validateUserOp_session_gas_within_remaining_grant_proceeds() public {
        SmartAccount account = _deployClone();
        SessionGasSink sink = new SessionGasSink();
        address sessionKey = vm.addr(SESSION_PRIV);
        SessionKeyLib.SessionSpec memory spec = _legalSpec(sessionKey, address(sink));
        spec.selectors[0] = SessionGasSink.hold.selector;
        account.grantSession(spec);

        uint256 grant = spec.spendLimitWei;
        uint256 prior = grant / 2;
        vm.deal(address(account), grant * 2);
        bytes memory hold = abi.encodeWithSelector(SessionGasSink.hold.selector);
        account.executeWithSession(spec, address(sink), prior, hold);
        require(account.getSession(sessionKey).spentWei == prior, "call value inside the grant");
        require(address(sink).balance == prior, "capped call value paid the target");

        _assertGasAboveRemainingRefused(account, sink, spec, prior, grant - prior);
        _assertGasInsideRemainingPays(account, sink, spec, prior, grant);
        _assertCallValueStillCapped(account, sink, spec, prior, grant);
    }

    function _assertGasAboveRemainingRefused(
        SmartAccount account,
        SessionGasSink sink,
        SessionKeyLib.SessionSpec memory spec,
        uint256 prior,
        uint256 remaining
    ) internal {
        uint256 accountBefore = address(account).balance;
        uint256 entryBefore = address(this).balance;
        bytes32 overHash = keccak256("session-gas-over-remaining");
        PackedUserOperation memory overOp = _sessionExecuteOp(account, spec, address(sink), 0, overHash);
        try account.validateUserOp(overOp, overHash, remaining + 1) {
            revert("gas above the remaining grant must revert");
        } catch (bytes memory reason) {
            require(_selector(reason) == SmartAccount.SessionSpendLimitExceeded.selector, "remaining grant");
        }
        require(address(account).balance == accountBefore, "over-remaining gas moved account eth");
        require(address(this).balance == entryBefore, "over-remaining gas paid the entry point");
        require(account.getSession(spec.key).spentWei == prior, "over-remaining gas counted");
    }

    function _assertGasInsideRemainingPays(
        SmartAccount account,
        SessionGasSink sink,
        SessionKeyLib.SessionSpec memory spec,
        uint256 prior,
        uint256 grant
    ) internal {
        uint256 pay = (grant - prior) / 2;
        uint256 accountBefore = address(account).balance;
        uint256 entryBefore = address(this).balance;
        bytes32 payHash = keccak256("session-gas-within-remaining");
        uint256 data = account.validateUserOp(_sessionExecuteOp(account, spec, address(sink), 0, payHash), payHash, pay);
        require(data != SIG_VALIDATION_FAILED, "gas inside the remaining grant must validate");
        require(uint160(data) == 0, "authorizer must be zero on success");
        require(address(account).balance == accountBefore - pay, "account paid the remaining grant");
        require(address(this).balance == entryBefore + pay, "entry point received the grant");
        require(account.getSession(spec.key).spentWei == prior + pay, "gas draws the stored grant");
    }

    function _assertCallValueStillCapped(
        SmartAccount account,
        SessionGasSink sink,
        SessionKeyLib.SessionSpec memory spec,
        uint256 prior,
        uint256 grant
    ) internal {
        bytes memory hold = abi.encodeWithSelector(SessionGasSink.hold.selector);
        uint256 pay = (grant - prior) / 2;
        uint256 leftover = grant - prior - pay;
        account.executeWithSession(spec, address(sink), leftover, hold);
        require(account.getSession(spec.key).spentWei == grant, "call value uses what the grant has left");
        require(address(sink).balance == prior + leftover, "in-cap call value still pays");
        _assertCallValueOverGrantRefused(account, sink, spec, grant - prior);
    }

    function _assertCallValueOverGrantRefused(
        SmartAccount account,
        SessionGasSink sink,
        SessionKeyLib.SessionSpec memory spec,
        uint256 value
    ) internal {
        bytes memory hold = abi.encodeWithSelector(SessionGasSink.hold.selector);
        uint256 sinkBefore = address(sink).balance;
        uint256 accountBefore = address(account).balance;
        try account.executeWithSession(spec, address(sink), value, hold) {
            revert("call value above the grant must revert");
        } catch (bytes memory reason) {
            require(_selector(reason) == SmartAccount.SessionSpendLimitExceeded.selector, "call value cap");
        }
        require(address(sink).balance == sinkBefore, "over-cap call moved value");
        require(address(account).balance == accountBefore, "over-cap call drained the account");
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

    /// One selector and two targets is not a pair. The selector must not run on the second target.
    function test_one_selector_is_not_granted_on_the_second_target() public {
        SmartAccount account = _deployClone();
        SessionReenter first = new SessionReenter(account);
        SessionReenter second = new SessionReenter(account);

        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(first));
        spec.targets = new address[](2);
        spec.targets[0] = address(first);
        spec.targets[1] = address(second);
        spec.selectors = new bytes4[](1);
        spec.selectors[0] = SessionReenter.ping.selector;
        account.grantSession(spec);

        try account.executeWithSession(spec, address(second), 0, abi.encodeWithSelector(SessionReenter.ping.selector)) {
            revert("selector ran on the second target");
        } catch {}
    }

    /// A native cap of 0 does not price a venue payout. The session may swap or
    /// sweep only back to the account, and a selector is not borrowed onto the
    /// other allowlisted target.
    function test_session_venue_call_cannot_pay_an_attacker() public {
        SmartAccount account = _deployClone();
        SessionPayoutVenue venue = new SessionPayoutVenue();
        SessionPayoutVenue otherVenue = new SessionPayoutVenue();
        _assertSwapRecipientAndPairing(account, venue, otherVenue);
        _assertRouterRecipient(account, venue);
    }

    function _assertSwapRecipientAndPairing(SmartAccount account, SessionPayoutVenue venue, SessionPayoutVenue otherVenue)
        internal
    {
        address attacker = address(0xA77AC);
        bytes4 swapSel = SessionPayoutVenue.swapExactTokensForTokens.selector;
        bytes4 otherSel = SessionPayoutVenue.other.selector;

        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(venue));
        spec.spendLimitWei = 0;
        spec.targets = new address[](2);
        spec.targets[0] = address(venue);
        spec.targets[1] = address(otherVenue);
        spec.selectors = new bytes4[](2);
        spec.selectors[0] = swapSel;
        spec.selectors[1] = otherSel;
        account.grantSession(spec);

        address[] memory path = new address[](2);
        path[0] = address(0x1111);
        path[1] = address(0x2222);
        bytes memory toAttacker = abi.encodeWithSelector(swapSel, uint256(1 ether), uint256(0), path, attacker, block.timestamp);
        try account.executeWithSession(spec, address(venue), 0, toAttacker) {
            revert("swap paid the attacker");
        } catch {}
        require(venue.paid() == address(0), "swap forwarded the attacker");

        bytes memory toAccount =
            abi.encodeWithSelector(swapSel, uint256(1 ether), uint256(0), path, address(account), block.timestamp);
        account.executeWithSession(spec, address(venue), 0, toAccount);
        require(venue.paid() == address(account), "swap to the account");
        require(account.getSession(spec.key).spentWei == 0, "native cap unchanged");

        bytes memory borrowed = abi.encodeWithSelector(otherSel, uint256(1));
        try account.executeWithSession(spec, address(venue), 0, borrowed) {
            revert("selector ran on every target");
        } catch {}

        bytes memory paired = account.executeWithSession(spec, address(otherVenue), 0, borrowed);
        require(abi.decode(paired, (uint256)) == 7, "paired selector on its target");
    }

    function _assertRouterRecipient(SmartAccount account, SessionPayoutVenue venue) internal {
        address attacker = address(0xA77AC);
        bytes4 execSel = SessionPayoutVenue.execute.selector;
        SessionKeyLib.SessionSpec memory routerSpec = _legalSpec(address(0xBEEF), address(venue));
        routerSpec.spendLimitWei = 0;
        routerSpec.selectors[0] = execSel;
        account.grantSession(routerSpec);
        venue.clear();

        bytes memory commands = abi.encodePacked(bytes1(0x04));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(address(0x1111), attacker, uint256(0));
        try account.executeWithSession(routerSpec, address(venue), 0, abi.encodeWithSelector(execSel, commands, inputs, block.timestamp))
        {
            revert("router paid the attacker");
        } catch {}
        require(venue.paid() == address(0), "router forwarded the attacker");

        inputs[0] = abi.encode(address(0x1111), address(account), uint256(0));
        account.executeWithSession(routerSpec, address(venue), 0, abi.encodeWithSelector(execSel, commands, inputs, block.timestamp));
        require(venue.paid() == address(account), "router paid the account");
    }

    function test_grantSession_gas_ceiling() public {
        SmartAccount account = _deployClone();
        SessionKeyLib.SessionSpec memory spec = _legalSpec(address(0xBEEF), address(0xCAFE));
        uint256 start = gasleft();
        account.grantSession(spec);
        uint256 used = start - gasleft();
        require(used < 250_000, "grantSession gas drifted");
    }
}
