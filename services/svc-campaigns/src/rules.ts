import type { CampaignParticipant } from '@intafaced/contracts';
import {
  RULE_FIXTURES,
  type RuleCondition,
  type RuleGroup,
  type RuleNode,
  type RuleTestResult,
} from '@intafaced/contracts/campaigns-catalogue';
import { CampaignsError } from './codes.js';

/**
 * Rule trees (CM-eligibility-rules-02, ENGINE EL-4): AND and OR groups of conditions on the account svc-identity
 * describes. A tree is checked against the owner's depth and size limits before it is tried, saved or put on a campaign;
 * a blank limit refuses by name, never a default. Evaluating runs no outside code and reads only the account it is given.
 */

export interface RuleLimits {
  /** The deepest nesting of groups, the outer group counting as 1; null while the owner value is blank. */
  depth: number | null;
  /** The most groups and conditions in one tree; null while blank. */
  size: number | null;
}

/** The account fields a condition reads. */
export type RuleAccount = Pick<CampaignParticipant, 'accountType' | 'region' | 'kycTier' | 'status'>;

const TIER_ORDER = ['none', 'basic', 'full', 'institutional'] as const;

function measure(node: RuleNode, depth: number): { depth: number; size: number } {
  if (node.kind === 'condition') return { depth: depth - 1, size: 1 };
  if (node.parts.length === 0) throw new CampaignsError('campaigns.rule_empty_group', 'Every group holds at least one condition');
  let deepest = depth;
  let size = 1;
  for (const part of node.parts) {
    const m = measure(part, depth + 1);
    deepest = Math.max(deepest, m.depth);
    size += m.size;
  }
  return { depth: deepest, size };
}

/** Refuses a tree the owner's limits do not allow: blank limits, a group with nothing in it, too deep or too large. */
export function checkRule(tree: RuleGroup, limits: RuleLimits): void {
  if (limits.depth === null) throw new CampaignsError('campaigns.rule_depth_unset', 'The rule depth limit is not set');
  if (limits.size === null) throw new CampaignsError('campaigns.rule_size_unset', 'The rule size limit is not set');
  const { depth, size } = measure(tree, 1);
  if (depth > limits.depth) {
    throw new CampaignsError('campaigns.rule_too_deep', `The rule nests ${depth} groups deep; the limit is ${limits.depth}`);
  }
  if (size > limits.size) {
    throw new CampaignsError('campaigns.rule_too_large', `The rule holds ${size} groups and conditions; the limit is ${limits.size}`);
  }
}

function holds(c: RuleCondition, who: RuleAccount): boolean {
  switch (c.field) {
    case 'accountType':
      return who.accountType === c.is;
    case 'region':
      // No region recorded passes neither test: a region rule never passes on a blank.
      if (!who.region) return false;
      return c.test === 'in' ? c.regions.includes(who.region) : !c.regions.includes(who.region);
    case 'kycTier':
      return TIER_ORDER.indexOf(who.kycTier) >= TIER_ORDER.indexOf(c.atLeast);
    case 'status':
      return who.status === c.is;
  }
}

/**
 * The tree's answer for one account, with every condition that fails (all of them, not only the first), each by its
 * place: `2.1` is the first part of the outer group's second part.
 */
export function evaluateRule(
  tree: RuleGroup,
  who: RuleAccount,
): { passes: boolean; failing: { path: string; condition: RuleCondition }[] } {
  const failing: { path: string; condition: RuleCondition }[] = [];
  const walk = (node: RuleNode, path: string): boolean => {
    if (node.kind === 'condition') {
      const ok = holds(node, who);
      if (!ok) failing.push({ path, condition: node });
      return ok;
    }
    const results = node.parts.map((part, i) => walk(part, path ? `${path}.${i + 1}` : String(i + 1)));
    return node.op === 'and' ? results.every(Boolean) : results.some(Boolean);
  };
  return { passes: walk(tree, ''), failing };
}

/** Tries a tree on a TEST fixture account: checks the limits, reads nothing and stores nothing. */
export function tryRule(tree: RuleGroup, fixtureId: string, limits: RuleLimits): RuleTestResult {
  checkRule(tree, limits);
  const fixture = RULE_FIXTURES.find((f) => f.id === fixtureId);
  if (!fixture) throw new Error(`Unknown fixture account: ${fixtureId}`);
  return { fixture: fixture.id, ...evaluateRule(tree, fixture.account) };
}

/** An owner limit from the environment: a positive whole number, blank as null; anything else refuses at boot. */
export function parseRuleLimit(name: string, raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^[1-9]\d{0,3}$/.test(value)) throw new Error(`${name} must be a whole number from 1 to 9999: ${value}`);
  return Number(value);
}
