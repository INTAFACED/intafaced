import { parseAmount as amt } from '@intafaced/ledger-client';
import { describe, expect, it } from 'vitest';
import { evaluatePolicy, validateRules, type PolicyTx, type UsedInWindow } from './engine.js';
import type { PolicyRule } from './schemas.js';

// TEST figures, illustrative only. The engine has no defaults of its own.
const tx = (o: Partial<PolicyTx> = {}): PolicyTx => ({
  initiator: 'user-1',
  assetId: 'USDT',
  amount: amt('5'),
  network: 'testnet-evm',
  destinationKind: 'crypto',
  destinationRef: '0xabc',
  txType: 'transfer',
  ...o,
});
const none: UsedInWindow = async () => 0n;
const allowAll: PolicyRule = { id: 'allow-all', action: 'allow', match: {} };
const group = { members: ['founder-a', 'founder-b'], threshold: 2, initiatorMayApprove: false };

describe('custody policy engine (W-custody-ops-07)', () => {
  it('first matching rule applies', async () => {
    const rules: PolicyRule[] = [
      {
        id: 'big-needs-approval',
        action: 'approve',
        match: { assets: ['USDT'], amountOver: { amount: '4', unit: 'native' } },
        approval: group,
      },
      allowAll,
    ];
    const big = await evaluatePolicy(rules, tx(), none);
    expect(big).toMatchObject({ outcome: 'approve', ruleId: 'big-needs-approval', matchedRuleIds: ['big-needs-approval', 'allow-all'] });
    expect(big.approval).toEqual(group);
    expect(await evaluatePolicy(rules, tx({ amount: amt('4') }), none)).toMatchObject({ outcome: 'allow', ruleId: 'allow-all' });
  });

  it('a block beats an earlier accept', async () => {
    const rules: PolicyRule[] = [allowAll, { id: 'deny-bad', action: 'block', match: { destinationsIn: ['0xbad'] } }];
    expect(await evaluatePolicy(rules, tx({ destinationRef: '0xbad' }), none)).toMatchObject({ outcome: 'block', ruleId: 'deny-bad' });
    expect(await evaluatePolicy(rules, tx(), none)).toMatchObject({ outcome: 'allow', ruleId: 'allow-all' });
  });

  it('no matching rule is no_match (default deny), never allow', async () => {
    const rules: PolicyRule[] = [{ id: 'only-eth', action: 'allow', match: { networks: ['eth'] } }];
    expect(await evaluatePolicy(rules, tx(), none)).toEqual({ outcome: 'no_match', ruleId: null, matchedRuleIds: [], approval: null });
  });

  it('matches destination deny lists, kinds, tx types and initiators', async () => {
    const rules: PolicyRule[] = [
      {
        id: 'r',
        action: 'allow',
        match: { destinationsNotIn: ['0xbad'], destinationKinds: ['crypto'], txTypes: ['transfer'], initiators: ['user-1'] },
      },
    ];
    expect((await evaluatePolicy(rules, tx(), none)).outcome).toBe('allow');
    expect((await evaluatePolicy(rules, tx({ destinationRef: '0xbad' }), none)).outcome).toBe('no_match');
    expect((await evaluatePolicy(rules, tx({ destinationKind: 'bank' }), none)).outcome).toBe('no_match');
    expect((await evaluatePolicy(rules, tx({ txType: 'contract_call' }), none)).outcome).toBe('no_match');
    expect((await evaluatePolicy(rules, tx({ initiator: 'user-2' }), none)).outcome).toBe('no_match');
  });

  it('cumulative rule adds what the window already used, for that initiator, asset and window', async () => {
    const rules: PolicyRule[] = [
      { id: 'cum', action: 'block', match: { assets: ['USDT'], cumulativeOver: { amount: '10', unit: 'native', windowSeconds: 3600 } } },
      allowAll,
    ];
    const asked: unknown[] = [];
    const used =
      (v: string): UsedInWindow =>
      async (q) => {
        asked.push(q);
        return amt(v);
      };
    expect((await evaluatePolicy(rules, tx(), used('5'))).outcome).toBe('allow');
    expect((await evaluatePolicy(rules, tx(), used('5.000000000000000001'))).outcome).toBe('block');
    expect(asked[0]).toEqual({ initiator: 'user-1', assetId: 'USDT', windowSeconds: 3600 });
  });

  it('refuses to evaluate an invalid rule set', async () => {
    await expect(evaluatePolicy([], tx(), none)).rejects.toThrow(/invalid/);
  });

  it('validate: reports every problem per rule; blank is never read as any', () => {
    const bad = [
      { id: '', action: 'allow', match: {} },
      { id: 'dup', action: 'allow', match: { assets: [] } },
      { id: 'dup', action: 'allow', match: { networks: [' '] } },
      { id: 'amt', action: 'block', match: { amountOver: { amount: '0', unit: 'native' } } },
      { id: 'usd', action: 'block', match: { assets: ['USDT'], amountOver: { amount: '1', unit: 'USD' } } },
      { id: 'win', action: 'block', match: { assets: ['USDT'], cumulativeOver: { amount: '1', unit: 'native', windowSeconds: 0 } } },
      { id: 'nogroup', action: 'approve', match: {} },
      { id: 'extra', action: 'allow', match: {}, approval: group },
      { id: 'thr', action: 'additional_signers', match: {}, approval: { members: ['a', 'a'], threshold: 3, initiatorMayApprove: true } },
      { id: 'blankamt', action: 'block', match: { assets: ['USDT'], amountOver: { amount: 'x', unit: 'native' } } },
    ] as PolicyRule[];
    const problems = validateRules(bad);
    const of = (id: string | null) => problems.filter((p) => p.ruleId === id).map((p) => p.problem);
    expect(of(null)).toEqual(['rule id is blank']);
    expect(of('dup')).toEqual(['assets is empty; leave it out to match any', 'rule id is used twice', 'networks has a blank entry']);
    expect(of('amt')).toEqual(['amount must be a positive decimal string', 'an amount rule must name exactly one asset']);
    expect(of('usd')).toEqual(['amounts in USD need a price source, which this build does not have']);
    expect(of('win')).toEqual(['windowSeconds must be positive']);
    expect(of('nogroup')).toEqual(['action approve needs an approval group']);
    expect(of('extra')).toEqual(['action allow takes no approval group']);
    expect(of('thr')).toEqual(['approval group lists a member twice', 'approval threshold must be between 1 and the number of members']);
    expect(of('blankamt')).toEqual(['amount must be a positive decimal string']);
    expect(validateRules([])).toEqual([{ ruleId: null, problem: 'a policy needs at least one rule' }]);
    expect(validateRules([allowAll])).toEqual([]);
  });
});
