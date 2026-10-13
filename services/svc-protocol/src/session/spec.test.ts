import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import type { Address, Hex } from 'viem';
import {
  assertGrantableSession,
  createSessionSpec,
  decodeSessionSpec,
  encodeSessionSpec,
  evaluateSessionCall,
  FORBIDDEN_SELECTORS,
  FORBIDDEN_SIGNATURES,
  hashSessionSpec,
  isOutboundTransferSelector,
  MAX_SESSION_DURATION_SECONDS,
  MAX_SELECTORS,
  MAX_TARGETS,
  RECIPIENT_SCOPED_CALLS,
  sessionSpecInputSchema,
  SessionScopeError,
  type SessionSpec,
  type SessionSpecInput,
} from './spec.js';

const ACCOUNT: Address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESSION_KEY: Address = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const VENUE: Address = '0xcccccccccccccccccccccccccccccccccccccccc';
const NOW = 1_800_000_000;

const SWAP = toFunctionSelector('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)');
const PLACE_ORDER = toFunctionSelector('placeOrder(address,bool,uint256,uint256)');

const here = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(here, '..', '..', 'contracts');

function input(overrides: Partial<SessionSpecInput> = {}): SessionSpecInput {
  return sessionSpecInputSchema.parse({
    key: SESSION_KEY,
    validAfter: 0,
    validUntil: NOW + 3600,
    spendLimitWei: '1000000000000000000',
    targets: [VENUE],
    selectors: [SWAP],
    ...overrides,
  });
}

function spec(overrides: Partial<SessionSpecInput> = {}): SessionSpec {
  return createSessionSpec(input(overrides), { account: ACCOUNT, now: NOW });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('THE RULE — a session key cannot be constructed with withdrawal power', () => {
  it.each([...FORBIDDEN_SIGNATURES])('refuses to build a session that can call %s', (signature) => {
    const selector = toFunctionSelector(signature);
    expect(() => spec({ selectors: [selector] })).toThrowError(SessionScopeError);

    try {
      spec({ selectors: [selector] });
      throw new Error('a session with withdrawal power was constructed — the custody boundary moved');
    } catch (err) {
      expect(err).toBeInstanceOf(SessionScopeError);
      expect((err as SessionScopeError).code).toBe('session.outbound_transfer_forbidden');
    }
  });

  it('refuses even when the transfer selector is buried among legitimate ones', () => {
    expect(() => spec({ selectors: [SWAP, PLACE_ORDER, toFunctionSelector('transfer(address,uint256)')] })).toThrowError(
      /never be granted/,
    );
  });

  it('refuses the ERC-20 approve selector — an allowance is a delayed transfer', () => {
    expect(() => spec({ selectors: [toFunctionSelector('approve(address,uint256)')] })).toThrowError(SessionScopeError);
  });

  it('refuses a selector that would let the session take the account itself', () => {
    expect(() => spec({ selectors: [toFunctionSelector('transferOwnership(address)')] })).toThrowError(SessionScopeError);
  });

  it('refuses the account itself as a target, closing every escalation path', () => {
    // If a session could call its own account it could grant itself a wider
    // session, rotate the owner, or revoke the user. This one rule closes all
    // three at once.
    try {
      spec({ targets: [ACCOUNT] });
      throw new Error('a session was allowed to call its own account');
    } catch (err) {
      expect((err as SessionScopeError).code).toBe('session.self_target_forbidden');
    }
  });

  it('refuses the zero selector — a raw fallback call is not an exact allowlist', () => {
    try {
      spec({ selectors: ['0x00000000'] });
      throw new Error('a fallback session was constructed');
    } catch (err) {
      expect((err as SessionScopeError).code).toBe('session.fallback_selector_forbidden');
    }
  });

  it('rejects a call to a forbidden selector at execution time as well as grant time', () => {
    // Defence in depth: even a spec that somehow reached the chain is refused
    // per call, so the two checks would both have to fail together.
    const live = spec({ selectors: [SWAP] });
    const decision = evaluateSessionCall({
      spec: { ...live, selectors: [...live.selectors, toFunctionSelector('transfer(address,uint256)')] },
      account: ACCOUNT,
      target: VENUE,
      value: 0n,
      data: encodeFunctionData({
        abi: [{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] }],
        functionName: 'transfer',
        args: [VENUE, 1n],
      }),
      spentWei: 0n,
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('session.outbound_transfer_forbidden');
  });
});

describe('expiry', () => {
  it('requires one', () => {
    try {
      spec({ validUntil: 0 });
      throw new Error('a permanent session was constructed');
    } catch (err) {
      expect((err as SessionScopeError).code).toBe('session.expiry_required');
    }
  });

  it('refuses an expiry in the past', () => {
    expect(() => spec({ validUntil: NOW - 1 })).toThrowError(/not in the future/);
  });

  it('caps the duration at 30 days', () => {
    expect(() => spec({ validUntil: NOW + MAX_SESSION_DURATION_SECONDS })).not.toThrow();
    try {
      spec({ validUntil: NOW + MAX_SESSION_DURATION_SECONDS + 1 });
      throw new Error('an over-long session was constructed');
    } catch (err) {
      expect((err as SessionScopeError).code).toBe('session.duration_exceeded');
    }
  });

  it('measures the cap from `validAfter` when the session starts in the future', () => {
    const start = NOW + 86_400;
    expect(() => spec({ validAfter: start, validUntil: start + MAX_SESSION_DURATION_SECONDS })).not.toThrow();
    expect(() => spec({ validAfter: start, validUntil: start + MAX_SESSION_DURATION_SECONDS + 1 })).toThrowError(SessionScopeError);
  });

  it('refuses a window that closes before it opens', () => {
    // The contract reverts here rather than underflowing, so this side must
    // refuse too: a spec that passes locally and reverts on chain is worse than
    // one rejected outright.
    try {
      spec({ validAfter: NOW + 7200, validUntil: NOW + 3600 });
      throw new Error('an inverted validity window was accepted');
    } catch (err) {
      expect((err as SessionScopeError).code).toBe('session.expiry_in_past');
    }
  });

  it('denies a call before validAfter and at or after validUntil', () => {
    const s = spec({ validAfter: NOW + 100, validUntil: NOW + 200 });
    const call = { spec: s, account: ACCOUNT, target: VENUE, value: 0n, data: SWAP as Hex, spentWei: 0n };

    expect(evaluateSessionCall({ ...call, now: NOW }).code).toBe('session.not_yet_valid');
    expect(evaluateSessionCall({ ...call, now: NOW + 150 }).allowed).toBe(true);
    // The boundary is exclusive on purpose: the contract uses `>=`.
    expect(evaluateSessionCall({ ...call, now: NOW + 200 }).code).toBe('session.expired');
  });
});

describe('allowlists', () => {
  it('requires at least one target and one selector', () => {
    expect(() => spec({ targets: [] })).toThrowError(/target allowlist/);
    expect(() => spec({ selectors: [] })).toThrowError(/selector allowlist/);
  });

  it('caps list sizes', () => {
    const manyTargets = Array.from({ length: MAX_TARGETS + 1 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Address);
    expect(() => spec({ targets: manyTargets })).toThrowError(SessionScopeError);

    const manySelectors = Array.from({ length: MAX_SELECTORS + 1 }, (_, i) => `0x${(i + 1).toString(16).padStart(8, '0')}` as Hex);
    expect(() => spec({ selectors: manySelectors })).toThrowError(SessionScopeError);
  });

  it('rejects duplicates rather than silently deduplicating', () => {
    expect(() => spec({ targets: [VENUE, VENUE] })).toThrowError(/Duplicate target/);
    expect(() => spec({ selectors: [SWAP, SWAP] })).toThrowError(/Duplicate selector/);
  });

  it('denies a call to a target outside the allowlist', () => {
    const s = spec();
    const decision = evaluateSessionCall({
      spec: s,
      account: ACCOUNT,
      target: '0xdddddddddddddddddddddddddddddddddddddddd',
      value: 0n,
      data: SWAP as Hex,
      spentWei: 0n,
      now: NOW,
    });
    expect(decision.code).toBe('session.target_not_allowed');
  });

  it('denies a bare native transfer — no selector, no scope', () => {
    const decision = evaluateSessionCall({
      spec: spec(),
      account: ACCOUNT,
      target: VENUE,
      value: 1n,
      data: '0x',
      spentWei: 0n,
      now: NOW,
    });
    expect(decision.code).toBe('session.calldata_too_short');
  });

  it('denies a call to the account itself even if somehow allowlisted', () => {
    const s = spec();
    const decision = evaluateSessionCall({
      spec: { ...s, targets: [ACCOUNT] },
      account: ACCOUNT,
      target: ACCOUNT,
      value: 0n,
      data: SWAP as Hex,
      spentWei: 0n,
      now: NOW,
    });
    expect(decision.code).toBe('session.self_call_forbidden');
  });
});

describe('spend allowance', () => {
  it('allows a call inside the cap and reports the new total', () => {
    const s = spec({ spendLimitWei: '1000' });
    const decision = evaluateSessionCall({
      spec: s,
      account: ACCOUNT,
      target: VENUE,
      value: 400n,
      data: SWAP as Hex,
      spentWei: 500n,
      now: NOW,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.spentAfterWei).toBe(900n);
  });

  it('is cumulative — the cap is over the session, not per call', () => {
    const s = spec({ spendLimitWei: '1000' });
    const decision = evaluateSessionCall({
      spec: s,
      account: ACCOUNT,
      target: VENUE,
      value: 400n,
      data: SWAP as Hex,
      spentWei: 700n,
      now: NOW,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('session.spend_limit_exceeded');
  });

  it('allows exactly the cap and refuses one wei more', () => {
    const s = spec({ spendLimitWei: '1000' });
    const at = (value: bigint) =>
      evaluateSessionCall({
        spec: s,
        account: ACCOUNT,
        target: VENUE,
        value,
        data: SWAP as Hex,
        spentWei: 0n,
        now: NOW,
      });
    expect(at(1000n).allowed).toBe(true);
    expect(at(1001n).allowed).toBe(false);
  });

  it('keeps wei as a bigint end to end — a float would round a user cap away', () => {
    const wei = '9007199254740993'; // 2^53 + 1, unrepresentable as a double
    const s = spec({ spendLimitWei: wei });
    expect(s.spendLimitWei).toBe(9007199254740993n);
    expect(s.spendLimitWei.toString()).toBe(wei);
  });

  it('refuses a limit that does not fit the on-chain uint128', () => {
    expect(() => spec({ spendLimitWei: (2n ** 128n).toString() })).toThrowError(SessionScopeError);
  });

  it('permits a zero allowance — a session that may act but never spend', () => {
    const s = spec({ spendLimitWei: '0' });
    expect(
      evaluateSessionCall({
        spec: s,
        account: ACCOUNT,
        target: VENUE,
        value: 0n,
        data: SWAP as Hex,
        spentWei: 0n,
        now: NOW,
      }).allowed,
    ).toBe(true);
  });
});

describe('scope encoding', () => {
  it('round-trips through abi encoding without loss', () => {
    const original = spec({ targets: [VENUE], selectors: [SWAP, PLACE_ORDER] });
    const decoded = decodeSessionSpec(encodeSessionSpec(original));
    expect(decoded).toEqual(original);
  });

  it('is stable — the commitment a user signs must not move under them', () => {
    const s = spec();
    expect(hashSessionSpec(s)).toBe(hashSessionSpec(spec()));
    expect(hashSessionSpec(s)).toBe('0xb2a36893542b7a8cd06493f5d5c9bb0e8ba156232d44d1cd571071126ab4b8a7');
  });

  it('changes when any field changes — no two scopes share a commitment', () => {
    const base = hashSessionSpec(spec());
    expect(hashSessionSpec(spec({ validUntil: NOW + 7200 }))).not.toBe(base);
    expect(hashSessionSpec(spec({ spendLimitWei: '2' }))).not.toBe(base);
    expect(hashSessionSpec(spec({ selectors: [PLACE_ORDER] }))).not.toBe(base);
    expect(hashSessionSpec(spec({ targets: ['0xdddddddddddddddddddddddddddddddddddddddd'] }))).not.toBe(base);
  });

  it('distinguishes the same selectors in a different order', () => {
    // Order matters on chain (the allowlist is an array), so it must matter here.
    expect(hashSessionSpec(spec({ selectors: [SWAP, PLACE_ORDER] }))).not.toBe(hashSessionSpec(spec({ selectors: [PLACE_ORDER, SWAP] })));
  });
});

describe('the Solidity library refuses the same selectors', () => {
  const source = readFileSync(join(contractsDir, 'SessionKeyLib.sol'), 'utf8');

  it.each([...FORBIDDEN_SIGNATURES])('SessionKeyLib.sol hard-codes the selector for %s', (signature) => {
    const selector = toFunctionSelector(signature);
    expect(source.toLowerCase()).toContain(selector.toLowerCase());
  });

  it('checks every one of them in isOutboundTransfer', () => {
    const body = source.slice(source.indexOf('function isOutboundTransfer'));
    for (const signature of FORBIDDEN_SIGNATURES) {
      const selector = toFunctionSelector(signature);
      const constantName = [...source.matchAll(/bytes4 internal constant (SEL_\w+) = (0x[0-9a-fA-F]{8});/g)].find(
        ([, , value]) => value?.toLowerCase() === selector.toLowerCase(),
      )?.[1];
      expect(constantName, `no constant in SessionKeyLib.sol for ${signature}`).toBeDefined();
      expect(body).toContain(constantName as string);
    }
  });

  describe('recipient-bearing selectors', () => {
    const body = source.slice(source.indexOf('function recipientOffset'), source.indexOf('function assertRecipientIsAccount'));
    const constants = [...source.matchAll(/bytes4 internal constant (SEL_\w+) = (0x[0-9a-fA-F]{8});/g)];

    it.each([...RECIPIENT_SCOPED_CALLS])(
      'recipientOffset returns the byte offset of arg $recipientArg for $signature',
      ({ signature, recipientArg }) => {
        const selector = toFunctionSelector(signature).toLowerCase();
        const name = constants.find(([, , value]) => value?.toLowerCase() === selector)?.[1];
        expect(name, `no constant in SessionKeyLib.sol for ${signature}`).toBeDefined();
        expect(body).toContain(`if (selector == ${name}) return ${4 + 32 * recipientArg};`);
      },
    );

    it('constrains exactly the selectors the TypeScript mirror lists, no more and no fewer', () => {
      const returns = [...body.matchAll(/if \(selector == (SEL_\w+)\) return (\d+);/g)];
      expect(returns).toHaveLength(RECIPIENT_SCOPED_CALLS.length);
      expect(body.match(/return /g)).toHaveLength(RECIPIENT_SCOPED_CALLS.length + 1); // +1 for the `return 0` default
    });

    it('is enforced by SmartAccount.executeWithSession after the selector checks and before value is counted', () => {
      const account = readFileSync(join(contractsDir, 'SmartAccount.sol'), 'utf8');
      const at = account.indexOf('SessionKeyLib.assertRecipientIsAccount(selector, data, address(this));');
      expect(at).toBeGreaterThan(account.indexOf('SessionKeyLib.SessionOutboundTransferForbidden(selector)'));
      expect(at).toBeLessThan(account.indexOf('record.spentWei = uint128(attempted);'));
    });
  });

  it('agrees on the 30-day cap', () => {
    expect(source).toContain('MAX_SESSION_DURATION = 30 days');
    expect(MAX_SESSION_DURATION_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it('agrees on the list caps', () => {
    expect(source).toContain(`MAX_TARGETS = ${MAX_TARGETS}`);
    expect(source).toContain(`MAX_SELECTORS = ${MAX_SELECTORS}`);
  });
});

describe('helpers', () => {
  it('recognises a forbidden selector regardless of case', () => {
    const selector = toFunctionSelector('transfer(address,uint256)');
    expect(isOutboundTransferSelector(selector)).toBe(true);
    expect(isOutboundTransferSelector(selector.toUpperCase().replace('0X', '0x') as Hex)).toBe(true);
    expect(isOutboundTransferSelector(SWAP)).toBe(false);
  });

  it('maps every forbidden selector back to a readable signature', () => {
    for (const signature of FORBIDDEN_SIGNATURES) {
      expect(FORBIDDEN_SELECTORS.get(toFunctionSelector(signature))).toBe(signature);
    }
  });

  it('assertGrantableSession and createSessionSpec enforce identically', () => {
    const good = spec();
    expect(() => assertGrantableSession(good, { account: ACCOUNT, now: NOW })).not.toThrow();
    // The same spec becomes invalid the moment the granting account IS the
    // target — the rule is relational, not a property of the spec alone.
    expect(() => assertGrantableSession(good, { account: good.targets[0] as Address, now: NOW })).toThrow(SessionScopeError);
    // ...and invalid again once the clock reaches its expiry.
    expect(() => assertGrantableSession(good, { account: ACCOUNT, now: good.validUntil })).toThrow(SessionScopeError);
  });
});
