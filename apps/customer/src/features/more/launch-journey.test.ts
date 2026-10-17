import { describe, expect, it } from 'vitest';
import { assessResult, draftIssues, EMPTY_DRAFT, LAUNCH_STEPS, normaliseSymbol, type LaunchDraft } from './launch-journey';

const good: LaunchDraft = { name: 'Example Asset', symbol: 'EXA', supply: '1000000', decimals: '18', saleShare: '20' };

describe('launch issuer draft', () => {
  it('accepts well-formed terms', () => {
    expect(draftIssues(good)).toEqual([]);
  });
  it('names every field to fix on an empty draft', () => {
    expect(draftIssues(EMPTY_DRAFT)).toEqual(['name', 'symbol', 'supply', 'saleShare']);
  });
  it('rejects bad supply, symbol, decimals and sale share', () => {
    expect(draftIssues({ ...good, supply: '0' })).toContain('supply');
    expect(draftIssues({ ...good, supply: '-5' })).toContain('supply');
    expect(draftIssues({ ...good, supply: '1e9' })).toContain('supply');
    expect(draftIssues({ ...good, symbol: 'ex' })).toContain('symbol');
    expect(draftIssues({ ...good, decimals: '19' })).toContain('decimals');
    expect(draftIssues({ ...good, saleShare: '101' })).toContain('saleShare');
    expect(draftIssues({ ...good, saleShare: '0' })).toContain('saleShare');
  });
  it('normalises a typed symbol', () => {
    expect(normaliseSymbol('ab-c 1')).toBe('ABC1');
    expect(normaliseSymbol('abcdefghijklmnop')).toHaveLength(10);
  });
});

describe('launch journey', () => {
  it('lets only the pre-listing check run and draft the terms; the rest is blocked', () => {
    expect(LAUNCH_STEPS.filter((s) => s.mode === 'ready').map((s) => s.id)).toEqual(['check']);
    expect(LAUNCH_STEPS.filter((s) => s.mode === 'draft').map((s) => s.id)).toEqual(['details']);
    expect(LAUNCH_STEPS.filter((s) => s.mode === 'blocked')).toHaveLength(5);
  });
  it('only parses an assessment that is neither a badge nor a block decision', () => {
    const refuse = { status: 'refuse', reason: 'reputation_unread', isBadge: false, isBlockDecision: false, inventedCleanBadge: false };
    expect(assessResult.safeParse(refuse).success).toBe(true);
    expect(assessResult.safeParse({ ...refuse, isBadge: true }).success).toBe(false);
    expect(
      assessResult.safeParse({
        status: 'annotation',
        isBadge: false,
        isBlockDecision: false,
        deployer: '0xabc',
        lpLocks: 0,
        vestings: 1,
        patternFlags: [{ code: 'no_lp_locks' }],
        inventedCleanBadge: false,
      }).success,
    ).toBe(true);
  });
});
