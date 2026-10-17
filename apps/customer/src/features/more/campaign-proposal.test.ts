import { describe, expect, it } from 'vitest';
import { COPY_MAX, HEADLINE_MAX, proposalRequest, proposalResult } from './campaign-proposal';

describe('campaign proposal request', () => {
  it('sends only a trimmed headline and copy, never publish or budget fields', () => {
    expect(proposalRequest('  Spring  ', ' Join us ')).toEqual({ headline: 'Spring', copy: 'Join us' });
    expect(Object.keys(proposalRequest('a', 'b')!)).toEqual(['headline', 'copy']);
  });
  it('refuses empty or oversize input before any request', () => {
    expect(proposalRequest('', 'x')).toBeNull();
    expect(proposalRequest('x', '   ')).toBeNull();
    expect(proposalRequest('x'.repeat(HEADLINE_MAX + 1), 'x')).toBeNull();
    expect(proposalRequest('x', 'x'.repeat(COPY_MAX + 1))).toBeNull();
  });
});

describe('campaign proposal reply', () => {
  it('accepts an unpublished proposal and a named refusal', () => {
    expect(
      proposalResult.safeParse({
        status: 'proposal',
        isPublication: false,
        published: false,
        headline: 'h',
        inventedReturns: false,
        inventedBudget: false,
      }).success,
    ).toBe(true);
    expect(
      proposalResult.safeParse({
        status: 'refuse',
        reason: 'warehouse_dark',
        isPublication: false,
        published: false,
        warehouseConfigured: false,
        inventedReturns: false,
        inventedBudget: false,
      }).success,
    ).toBe(true);
  });
  it('rejects a reply that claims publication', () => {
    expect(
      proposalResult.safeParse({
        status: 'proposal',
        isPublication: true,
        published: true,
        headline: 'h',
        inventedReturns: false,
        inventedBudget: false,
      }).success,
    ).toBe(false);
  });
});
