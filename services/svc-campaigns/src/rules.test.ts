import { describe, expect, it } from 'vitest';
import type { RuleCondition, RuleGroup } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from './codes.js';
import { checkRule, evaluateRule, parseRuleLimit, tryRule } from './rules.js';

const LIMITS = { depth: 3, size: 6 };
const individual = { kind: 'condition', field: 'accountType', is: 'individual' } as const;
const verified = { kind: 'condition', field: 'kycTier', atLeast: 'basic' } as const;
const notKp: RuleCondition = { kind: 'condition', field: 'region', test: 'not_in', regions: ['KP'] };

const tree: RuleGroup = { kind: 'group', op: 'and', parts: [individual, { kind: 'group', op: 'or', parts: [verified, notKp] }] };

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(CampaignsError);
    return (err as CampaignsError).code;
  }
  throw new Error('expected a refusal');
};

describe('campaign rule trees', () => {
  it('names every failing condition by its place, not only the first', () => {
    const who = { accountType: 'business', region: 'KP', kycTier: 'none', status: 'active' } as const;
    const out = evaluateRule(tree, who);
    expect(out.passes).toBe(false);
    expect(out.failing.map((f) => f.path)).toEqual(['1', '2.1', '2.2']);
  });

  it('an OR group passes on any part; an AND group needs every part', () => {
    expect(evaluateRule(tree, { accountType: 'individual', region: 'KP', kycTier: 'full', status: 'active' })).toMatchObject({
      passes: true,
      failing: [{ path: '2.2' }],
    });
    expect(evaluateRule(tree, { accountType: 'individual', region: 'DE', kycTier: 'none', status: 'active' }).passes).toBe(true);
  });

  it('a region condition never passes on an account with no region recorded', () => {
    const inDe: RuleGroup = { kind: 'group', op: 'and', parts: [{ kind: 'condition', field: 'region', test: 'in', regions: ['DE'] }] };
    const notIn: RuleGroup = { kind: 'group', op: 'and', parts: [notKp] };
    const blank = { accountType: 'individual', region: null, kycTier: 'full', status: 'active' } as const;
    expect(evaluateRule(inDe, blank).passes).toBe(false);
    expect(evaluateRule(notIn, blank).passes).toBe(false);
  });

  it('blank limits, an empty group, too deep and too large each refuse by name', () => {
    expect(code(() => checkRule(tree, { depth: null, size: 6 }))).toBe('campaigns.rule_depth_unset');
    expect(code(() => checkRule(tree, { depth: 3, size: null }))).toBe('campaigns.rule_size_unset');
    expect(code(() => checkRule({ kind: 'group', op: 'and', parts: [] }, LIMITS))).toBe('campaigns.rule_empty_group');
    expect(() => checkRule(tree, LIMITS)).not.toThrow();
    const deep: RuleGroup = {
      kind: 'group',
      op: 'and',
      parts: [
        { kind: 'group', op: 'or', parts: [{ kind: 'group', op: 'and', parts: [{ kind: 'group', op: 'or', parts: [individual] }] }] },
      ],
    };
    expect(code(() => checkRule(deep, LIMITS))).toBe('campaigns.rule_too_deep');
    expect(
      code(() =>
        checkRule({ kind: 'group', op: 'and', parts: [individual, individual, individual, individual, individual, individual] }, LIMITS),
      ),
    ).toBe('campaigns.rule_too_large');
  });

  it('tries a rule on a TEST fixture account and stores nothing', () => {
    expect(tryRule(tree, 'test-business-kp', LIMITS)).toMatchObject({ fixture: 'test-business-kp', passes: false });
    expect(tryRule(tree, 'test-individual-de', LIMITS)).toMatchObject({ passes: true, failing: [] });
  });

  it('reads an owner limit as a whole number, blank as unset', () => {
    expect(parseRuleLimit('X', ' ')).toBeNull();
    expect(parseRuleLimit('X', '4')).toBe(4);
    expect(() => parseRuleLimit('X', '0')).toThrow(/whole number/);
    expect(() => parseRuleLimit('X', '2.5')).toThrow(/whole number/);
  });
});
