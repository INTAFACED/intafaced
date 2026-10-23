import { describe, expect, it } from 'vitest';
import { ACCOUNT_TIER_TERM_KEYS } from '@intafaced/contracts';
import { TIER_TERM_KEYS } from './tier-terms';

describe('tier terms', () => {
  it('keeps the same terms, in the same order, as identity', () => {
    expect([...TIER_TERM_KEYS]).toEqual([...ACCOUNT_TIER_TERM_KEYS]);
  });
});
