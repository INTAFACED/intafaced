import { describe, expect, it } from 'vitest';
import type { Context } from '@intafaced/contracts';
import { learnerCardTerm, lookupLearnerCard } from './learner-card.js';

const ctx = (scopes: string[], extra: Record<string, unknown> = {}) =>
  ({ service: null, principal: { userId: '11111111-1111-4111-8111-111111111111', scopes, mfa: true, ...extra } }) as unknown as Context;
const noSql = (() => {
  throw new Error('no read may run');
}) as never;

describe('learnerCard.lookup (J-academy-14 #1)', () => {
  it('takes exactly one whole email, handle or account id', () => {
    expect(learnerCardTerm({ email: ' Learner@Example.TEST ' })).toEqual({ kind: 'email', value: 'learner@example.test' });
    expect(learnerCardTerm({ handle: 'j14learner' })).toEqual({ kind: 'handle', value: 'j14learner' });
    expect(learnerCardTerm({ userId: '22222222-2222-4222-8222-222222222222' }).kind).toBe('id');
    expect(() => learnerCardTerm({})).toThrow(/identity.account_search_unset/);
    expect(() => learnerCardTerm({ email: 'a@b.test', handle: 'abc' })).toThrow(/identity.account_search_unset/);
  });

  it('needs admin:read on an interactive second-factor session, and reads nothing otherwise', async () => {
    await expect(lookupLearnerCard(noSql, ctx(['academy:read']), { handle: 'abc' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(lookupLearnerCard(noSql, ctx(['admin:read'], { kid: 'key' }), { handle: 'abc' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(lookupLearnerCard(noSql, ctx(['admin:read'], { sub_account: true }), { handle: 'abc' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(lookupLearnerCard(noSql, ctx(['admin:read'], { mfa: false }), { handle: 'abc' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
