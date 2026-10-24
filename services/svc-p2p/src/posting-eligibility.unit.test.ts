import { describe, expect, it } from 'vitest';
import { P2pError } from './p2p-service.js';
import { asKycTier, fiatPostingPolicy, parsePostingThresholds, percentHundredths, postingChecks } from './posting-eligibility.js';
import { toTrpcError } from './router.js';

/** P-ads-merchant-12: reading compliance's posting thresholds, and judging one person against them. */

describe('posting thresholds (P-ads-merchant-12)', () => {
  it('reads a threshold per fiat, "none", and nothing for a fiat not listed', () => {
    const thresholds = parsePostingThresholds(
      JSON.stringify({ EUR: { minKycTier: 'full', minCompletedOrders: '5', minCompletionRatePct: '92.5' }, USD: 'none' }),
    );
    expect(fiatPostingPolicy(thresholds, 'EUR')).toEqual({
      policy: 'thresholds',
      threshold: { minKycTier: 'full', minCompletedOrders: '5', minCompletionRatePct: '92.5' },
    });
    expect(fiatPostingPolicy(thresholds, 'USD')).toEqual({ policy: 'none', threshold: null });
    expect(fiatPostingPolicy(thresholds, 'GBP')).toEqual({ policy: 'unset', threshold: null });
    expect(fiatPostingPolicy(parsePostingThresholds('  '), 'EUR')).toEqual({ policy: 'unset', threshold: null });
  });

  it('refuses to read a list that is not whole', () => {
    for (const raw of [
      'nope',
      '[]',
      '{}',
      '"none"',
      '{"eur":"none"}',
      '{"EUR":{}}',
      '{"EUR":"all"}',
      '{"EUR":{"minKycTier":"gold"}}',
      '{"EUR":{"minCompletedOrders":5}}',
      '{"EUR":{"minCompletedOrders":"-1"}}',
      '{"EUR":{"minCompletionRatePct":"100.01"}}',
      '{"EUR":{"minCompletionRatePct":"90.123"}}',
      '{"EUR":{"minAccountAgeDays":"30"}}',
    ])
      expect(parsePostingThresholds(raw), raw).toEqual({ status: 'invalid' });
    expect(fiatPostingPolicy(parsePostingThresholds('[]'), 'EUR').policy).toBe('invalid');
  });

  it('compares a completion rate in hundredths of a percent, never as a float', () => {
    expect(percentHundredths('90')).toBe(9000);
    expect(percentHundredths('95.24')).toBe(9524);
    expect(percentHundredths('100.00')).toBe(10_000);
    expect(percentHundredths('100.5')).toBeNull();
    const threshold = { minCompletionRatePct: '95.24' };
    expect(postingChecks(threshold, { tier: 'basic', completedOrders: 3, completionRatePct: '95.24' })[0]!.state).toBe('met');
    expect(postingChecks(threshold, { tier: 'basic', completedOrders: 3, completionRatePct: '95.23' })[0]!.state).toBe('not_met');
  });

  it('ranks the verification levels in order, and a level that is not one is unknown', () => {
    const threshold = { minKycTier: 'full' as const };
    const state = (tier: string | undefined) =>
      postingChecks(threshold, { tier: asKycTier(tier), completedOrders: 0, completionRatePct: null })[0]!.state;
    expect([state('none'), state('basic'), state('full'), state('institutional'), state('gold'), state(undefined)]).toEqual([
      'not_met',
      'not_met',
      'met',
      'met',
      'unknown',
      'unknown',
    ]);
  });

  it('reaches the caller as a request the person can fix, and a broken list as the operator’s', () => {
    expect(toTrpcError(new P2pError('x', 'p2p.posting_threshold_not_met')).code).toBe('BAD_REQUEST');
    expect(toTrpcError(new P2pError('x', 'p2p.posting_thresholds_invalid')).code).toBe('PRECONDITION_FAILED');
  });
});
