/**
 * Unit card — a session key cannot route pool-swap output to a stranger
 *
 * 1. Promise: a session granted a pool-swap selector can only swap for the
 *    account that granted it.
 * 2. Break: scope checked target, selector and native value only; swapExactIn's
 *    `to` was never read, so with the owner's ERC20 allowance in place a
 *    compromised key could swap the whole balance at minOut 0 to itself.
 * 3. Done bar: swapExactIn (pool and router) and every other call that names a
 *    recipient is refused when the recipient is not the account, and when the
 *    calldata ends before the recipient; a call to the account itself is
 *    allowed. SessionKeyLib enforces the same rule (spec.test.ts pins the
 *    selectors and offsets to the Solidity source; test/forge/SessionKey.t.sol
 *    runs it).
 * 4. Class M
 * 5. Paths: services/svc-protocol/src/session/spec.ts, contracts/SessionKeyLib.sol
 * 6. RED on 94403f7a: foreign recipient, minOut 0 → allowed "Within session scope"
 *
 * Not in this card: an owner-chosen ERC20 amount cap (a spec-format change; a
 * separate follow-up).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, parseAbiItem, toFunctionSelector } from 'viem';
import type { Abi, AbiFunction, AbiParameter, Address, Hex } from 'viem';
import { buildSwapExactIn } from '../amm/build.js';
import { createSessionSpec, evaluateSessionCall, isOutboundTransferSelector, RECIPIENT_OFFSETS, RECIPIENT_SCOPED_CALLS } from './spec.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x4444444444444444444444444444444444444444';
const KEY = '0x5555555555555555555555555555555555555555';
const ROUTER = '0x6666666666666666666666666666666666666666';
const NOW = 1_000_000;

function specFor(selectors: Hex[], target: Address = POOL) {
  return createSessionSpec(
    { key: KEY, validAfter: 0, validUntil: NOW + 1000, spendLimitWei: '0', targets: [target], selectors },
    { account: ACCOUNT, now: NOW },
  );
}

function decide(data: Hex, target: Address = POOL, account: Address = ACCOUNT) {
  const selector = data.slice(0, 10) as Hex;
  return evaluateSessionCall({ spec: specFor([selector], target), account, target, value: 0n, data, spentWei: 0n, now: NOW });
}

function routerSwap(to: Address): Hex {
  return encodeFunctionData({
    abi: [parseAbiItem('function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)')],
    args: [POOL, TOKEN, 1_000_000_000n, 0n, to],
  });
}

/** Calldata for any listed signature, with `recipient` in the recipient slot and 7 in every uint. */
function callFor(signature: string, recipientArg: number, recipient: Address): Hex {
  const item = parseAbiItem(`function ${signature}`) as AbiFunction;
  const args = item.inputs.map((input: AbiParameter, i: number) =>
    i === recipientArg ? recipient : input.type === 'address' ? TOKEN : 7n,
  );
  return encodeFunctionData({ abi: [item] as Abi, args });
}

describe('session scope for pool swaps', () => {
  it('refuses a swap whose output goes to someone other than the account', () => {
    const call = buildSwapExactIn(POOL, TOKEN, 1_000_000_000n, 0n, STRANGER);
    const spec = specFor([call.data.slice(0, 10) as Hex]);
    const decision = evaluateSessionCall({ spec, account: ACCOUNT, target: POOL, value: 0n, data: call.data, spentWei: 0n, now: NOW });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('session.recipient_not_account');
  });

  it('allows a swap whose output comes back to the account', () => {
    const call = buildSwapExactIn(POOL, TOKEN, 1_000_000_000n, 0n, ACCOUNT);
    const decision = decide(call.data);
    expect(decision.allowed).toBe(true);
    expect(decision.code).toBe('allowed');
  });

  it('matches the account regardless of address casing', () => {
    const account = getAddress('0xabcdef0123456789abcdef0123456789abcdef01');
    const call = buildSwapExactIn(POOL, TOKEN, 1n, 0n, account);
    expect(decide(call.data, POOL, account).allowed).toBe(true);
    expect(decide(call.data, POOL, account.toLowerCase() as Address).allowed).toBe(true);
    expect(decide(call.data, POOL, `0x${account.slice(2).toUpperCase()}` as Address).allowed).toBe(true);
  });

  it('refuses the zero address as the recipient', () => {
    const call = buildSwapExactIn(POOL, TOKEN, 1n, 0n, '0x0000000000000000000000000000000000000000');
    expect(decide(call.data).code).toBe('session.recipient_not_account');
  });
});

describe('session scope for the router swap', () => {
  it('refuses a router swap to a stranger', () => {
    const decision = decide(routerSwap(STRANGER), ROUTER);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('session.recipient_not_account');
  });

  it('allows a router swap to the account', () => {
    expect(decide(routerSwap(ACCOUNT), ROUTER).allowed).toBe(true);
  });

  it('does not mistake the router pool argument for the recipient', () => {
    // swapExactIn(pool, tokenIn, ..., to): ACCOUNT as the pool and STRANGER as `to` is still refused.
    const data = encodeFunctionData({
      abi: [parseAbiItem('function swapExactIn(address pool, address tokenIn, uint256 amountIn, uint256 minAmountOut, address to)')],
      args: [ACCOUNT, ACCOUNT, 1n, 0n, STRANGER],
    });
    expect(decide(data, ROUTER).code).toBe('session.recipient_not_account');
  });
});

describe.each(RECIPIENT_SCOPED_CALLS)('every recipient-bearing call: $signature', ({ signature, recipientArg }) => {
  it('is refused for a stranger and allowed for the account', () => {
    expect(decide(callFor(signature, recipientArg, STRANGER)).code).toBe('session.recipient_not_account');
    expect(decide(callFor(signature, recipientArg, ACCOUNT)).allowed).toBe(true);
  });

  it('is refused when the calldata ends before the recipient word', () => {
    const full = callFor(signature, recipientArg, ACCOUNT);
    const offset = 4 + 32 * recipientArg;
    // Selector only, mid-recipient (one byte short), and exactly at the end of the recipient word.
    expect(decide(full.slice(0, 10) as Hex).code).toBe('session.recipient_calldata_too_short');
    expect(decide(full.slice(0, 2 + (offset + 31) * 2) as Hex).code).toBe('session.recipient_calldata_too_short');
    expect(decide(full.slice(0, 2 + (offset + 32) * 2) as Hex).allowed).toBe(true);
  });

  it('is refused when the recipient word has dirty high bytes, even if its low 20 bytes are the account', () => {
    const full = callFor(signature, recipientArg, ACCOUNT);
    const start = 2 + (4 + 32 * recipientArg) * 2;
    const dirty = `${full.slice(0, start)}ff${full.slice(start + 2)}` as Hex;
    expect(decide(dirty).code).toBe('session.recipient_not_account');
  });

  it('keeps its offset in the lookup the evaluator uses', () => {
    expect(RECIPIENT_OFFSETS.get(toFunctionSelector(signature).toLowerCase() as Hex)).toBe(4 + 32 * recipientArg);
  });
});

describe('selectors with no recipient are unaffected', () => {
  it('still allows a bare selector of an unrelated call', () => {
    const selector = toFunctionSelector('placeOrder(address,bool,uint256,uint256)');
    expect(decide(selector as Hex).allowed).toBe(true);
  });

  it('still refuses a selector that is not allowlisted before it looks at a recipient', () => {
    const call = buildSwapExactIn(POOL, TOKEN, 1n, 0n, ACCOUNT);
    const spec = specFor([toFunctionSelector('placeOrder(address,bool,uint256,uint256)')]);
    const decision = evaluateSessionCall({ spec, account: ACCOUNT, target: POOL, value: 0n, data: call.data, spentWei: 0n, now: NOW });
    expect(decision.code).toBe('session.selector_not_allowed');
  });
});

describe('no recipient-bearing function in the compiled contracts is left out', () => {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'out');
  const RECIPIENT_NAMES = /^(to|recipient|receiver|dst|beneficiary|payee|destination)$/i;
  const listed = new Set(RECIPIENT_SCOPED_CALLS.map((c) => toFunctionSelector(c.signature).toLowerCase()));

  /**
   * Functions with a recipient-named address that a session is still allowed to
   * be given, and why. Everything else with one is either listed above or an
   * outbound-transfer selector a session can never hold.
   */
  const EXEMPT: Record<string, string> = {
    'mint(address)': 'SovereignNft.mint: mints a NEW token; no asset of the account moves',
    'mint(address,uint256)': 'MockERC20 / test token faucet only; not a deployed protocol surface',
    'withdrawFloat(address,uint256)': 'ScopedPaymaster: gated on msg.sender == operator; the account is never the operator',
  };

  it('lists every non-view function that names a recipient, or says why not', () => {
    const missing: string[] = [];
    for (const file of readdirSync(outDir).filter((f) => f.endsWith('.json'))) {
      const artifact = JSON.parse(readFileSync(join(outDir, file), 'utf8')) as { abi: Array<AbiFunction | { type: string }> };
      for (const entry of artifact.abi) {
        if (entry.type !== 'function') continue;
        const fn = entry as AbiFunction;
        if (fn.stateMutability === 'view' || fn.stateMutability === 'pure') continue;
        if (!fn.inputs.some((i) => i.type === 'address' && RECIPIENT_NAMES.test(i.name ?? ''))) continue;
        const signature = `${fn.name}(${fn.inputs.map((i) => i.type).join(',')})`;
        const selector = toFunctionSelector(signature).toLowerCase() as Hex;
        if (listed.has(selector) || isOutboundTransferSelector(selector) || signature in EXEMPT) continue;
        missing.push(`${file}: ${signature}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('puts every listed recipient at the argument position the compiled ABI declares', () => {
    const found = new Map<string, number>();
    for (const file of readdirSync(outDir).filter((f) => f.endsWith('.json'))) {
      const artifact = JSON.parse(readFileSync(join(outDir, file), 'utf8')) as { abi: Array<AbiFunction | { type: string }> };
      for (const entry of artifact.abi) {
        if (entry.type !== 'function') continue;
        const fn = entry as AbiFunction;
        const index = fn.inputs.findIndex((i) => i.type === 'address' && RECIPIENT_NAMES.test(i.name ?? ''));
        if (index >= 0) found.set(`${fn.name}(${fn.inputs.map((i) => i.type).join(',')})`, index);
      }
    }
    for (const { signature, recipientArg } of RECIPIENT_SCOPED_CALLS) {
      expect(found.get(signature), `${signature} is not in any compiled ABI with a recipient-named argument`).toBe(recipientArg);
    }
  });
});
