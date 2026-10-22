import { describe, expect, it } from 'vitest';
import {
  formatAmount,
  parseAmount as amt,
  railBoundary,
  recipes,
  subAccountAvailable,
  userAvailable,
  type AccountRef,
  type PostRequest,
} from '@intafaced/ledger-client';
import { assertKnownRecipePost, recipeCandidates } from './recipe-gate.js';

/**
 * The rail send and its return, exactly as svc-bank builds them in
 * `services/svc-bank/src/personal-pay/post.ts` (`postToRail`, `reverseFromRail`):
 * `bankTransfer` with `keySpace: 'rail'` between a space and the treasury rail
 * boundary. A space is a user's available account or a sub-account.
 */

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SPACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function toWire(req: PostRequest) {
  return {
    module: req.module,
    reason: req.reason,
    entries: req.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
  };
}

// postToRail
const toRail = (from: AccountRef, rail: string) =>
  recipes.bankTransfer({
    transferId: 'send-1',
    occurrence: 0,
    from,
    to: railBoundary(rail, from.assetId),
    amount: amt('25'),
    kind: 'manual',
    keySpace: 'rail',
  });

// reverseFromRail
const fromRail = (to: AccountRef, rail: string) =>
  recipes.bankTransfer({
    transferId: 'send-1',
    occurrence: 1,
    from: railBoundary(rail, to.assetId),
    to,
    amount: amt('25'),
    kind: 'manual',
    keySpace: 'rail',
  });

/** Bill pay and global send both go through postToRail / reverseFromRail; only the rail id differs. */
const cases = [
  ['bill pay', 'personal space', userAvailable(USER, 'USDT'), 'bills-rail'],
  ['bill pay', 'business space (sub-account)', subAccountAvailable(SPACE, 'USDT'), 'bills-rail'],
  ['global send', 'personal space', userAvailable(USER, 'USDT'), 'global-payout'],
  ['global send', 'business space (sub-account)', subAccountAvailable(SPACE, 'USDT'), 'global-payout'],
] as const;

describe('recipe gate: bankTransfer rail send and return', () => {
  it.each(cases)('accepts a %s rail send from a %s', (_flow, _space, from, rail) => {
    const wire = toWire(toRail(from, rail));
    expect(recipeCandidates(wire)).toContain('bankTransfer');
    expect(() => assertKnownRecipePost(wire)).not.toThrow();
  });

  it.each(cases)('accepts a %s rail return to a %s', (_flow, _space, to, rail) => {
    const wire = toWire(fromRail(to, rail));
    expect(recipeCandidates(wire)).toContain('bankTransfer');
    expect(() => assertKnownRecipePost(wire)).not.toThrow();
  });
});
