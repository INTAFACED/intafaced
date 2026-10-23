/**
 * Unit card — a session key cannot route ERC20 swap output to a stranger
 *
 * 1. Promise: a session granted a pool-swap selector can only swap for the
 *    account that granted it, within an ERC20 amount the owner chose.
 * 2. Break: scope checks target, selector and native value only; swapExactIn's
 *    `to` and `amountIn` are never read, so with the owner's ERC20 allowance in
 *    place a compromised key can swap the whole balance at minOut 0 to itself.
 * 3. Done bar: swapExactIn with a foreign recipient is refused; an amount over
 *    the granted ERC20 cap is refused; a swap to the account itself within the
 *    cap is allowed. The Solidity SessionKeyLib enforces the same rule.
 * 4. Class M
 * 5. Paths: services/svc-protocol/src/session/spec.ts, contracts/SessionKeyLib.sol
 * 6. RED on 11ab823a8: foreign recipient, minOut 0 → allowed "Within session scope"
 */
import { describe, expect, it } from 'vitest';
import { buildSwapExactIn } from '../amm/build.js';
import { createSessionSpec, evaluateSessionCall } from './spec.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const POOL = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const STRANGER = '0x4444444444444444444444444444444444444444';
const KEY = '0x5555555555555555555555555555555555555555';
const NOW = 1_000_000;

describe('session scope for ERC20 pool swaps', () => {
  it('refuses a swap whose output goes to someone other than the account', () => {
    const call = buildSwapExactIn(POOL, TOKEN, 1_000_000_000n, 0n, STRANGER);
    const spec = createSessionSpec(
      {
        key: KEY,
        validAfter: 0,
        validUntil: NOW + 1000,
        spendLimitWei: '0',
        targets: [POOL],
        selectors: [call.data.slice(0, 10) as `0x${string}`],
      },
      { account: ACCOUNT, now: NOW },
    );
    const decision = evaluateSessionCall({ spec, account: ACCOUNT, target: POOL, value: 0n, data: call.data, spentWei: 0n, now: NOW });
    expect(decision.allowed).toBe(false);
  });
});
