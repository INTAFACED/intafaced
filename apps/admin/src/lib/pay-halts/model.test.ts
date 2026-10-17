import { describe, expect, it } from 'vitest';
import type { PayHaltState } from '@intafaced/contracts';
import {
  canConfirmClear,
  describeTarget,
  explainOutcome,
  haltPhrase,
  scopeTargetProblem,
  setGate,
  stateFor,
  targetFrom,
  targetKey,
  versionFor,
} from './model';

const M = '33333333-3333-4333-8333-333333333333';
const state = (over: Partial<PayHaltState> = {}): PayHaltState => ({
  scope: 'intake',
  target: { level: 'global' },
  halted: false,
  reason: null,
  source: null,
  actorUserId: null,
  version: '0',
  changedAt: null,
  ...over,
});

describe('targets', () => {
  it('build from the form, rejecting anything that is not a UUID or a known rail shape', () => {
    expect(targetFrom('global', 'ignored')).toEqual({ level: 'global' });
    expect(targetFrom('merchant', M.toUpperCase())).toEqual({ level: 'merchant', merchantId: M });
    expect(targetFrom('user', ` ${M} `)).toEqual({ level: 'user', userId: M });
    expect(targetFrom('rail', 'sepa.instant')).toEqual({ level: 'rail', railId: 'sepa.instant' });
    for (const [level, id] of [
      ['merchant', 'not-a-uuid'],
      ['merchant', ''],
      ['user', '123'],
      ['rail', 'UPPER'],
      ['rail', ''],
      ['rail', ' bad id'],
    ] as const) {
      expect(targetFrom(level, id)).toBeNull();
    }
  });
  it('keys are unique per scope and target', () => {
    expect(targetKey('intake', { level: 'global' })).not.toBe(targetKey('payout', { level: 'global' }));
    expect(targetKey('payout', { level: 'user', userId: M })).not.toBe(targetKey('payout', { level: 'merchant', merchantId: M }));
  });
  it('are described in words', () => {
    expect(describeTarget({ level: 'global' })).toBe('Everyone (global)');
    expect(describeTarget({ level: 'user', userId: M })).toContain('withdrawal exit');
  });
  it('a user or rail halt only works on payouts', () => {
    expect(scopeTargetProblem('intake', { level: 'user', userId: M })).toContain('only works on payouts');
    expect(scopeTargetProblem('settlement', { level: 'rail', railId: 'sepa' })).not.toBeNull();
    expect(scopeTargetProblem('payout', { level: 'rail', railId: 'sepa' })).toBeNull();
    expect(scopeTargetProblem('intake', { level: 'merchant', merchantId: M })).toBeNull();
  });
});

describe('the version a write must carry', () => {
  it('is the row’s version, and 0 for a halt that was never set', () => {
    const rows = [
      state({ version: '4', halted: true }),
      state({ scope: 'payout', target: { level: 'merchant', merchantId: M }, version: '2' }),
    ];
    expect(versionFor(rows, 'intake', { level: 'global' })).toBe('4');
    expect(versionFor(rows, 'payout', { level: 'merchant', merchantId: M })).toBe('2');
    expect(versionFor(rows, 'conversion', { level: 'global' })).toBe('0');
    expect(stateFor(rows, 'intake', { level: 'global' })?.halted).toBe(true);
    expect(stateFor(rows, 'conversion', { level: 'global' })).toBeNull();
  });
});

describe('the form stays shut until everything is true', () => {
  const ok = {
    scope: 'payout',
    target: { level: 'global' },
    halted: true,
    reason: 'rail incident, stop sends',
    confirm: 'HALT payout',
    busy: false,
  } as const;
  it('opens with a target, a reason and the exact phrase for the operation', () => expect(setGate(ok)).toEqual({ ok: true }));
  it('the phrase names the operation and the direction', () => {
    expect(haltPhrase('payout', true)).toBe('HALT payout');
    expect(haltPhrase('intake', false)).toBe('CLEAR intake');
    expect(setGate({ ...ok, confirm: 'HALT intake' }).ok).toBe(false);
    expect(setGate({ ...ok, confirm: 'CLEAR payout' }).ok).toBe(false);
    expect(setGate({ ...ok, confirm: 'halt payout' }).ok).toBe(false);
  });
  it('needs a named target, a legal scope/target pair and a real reason', () => {
    expect(setGate({ ...ok, target: null }).ok).toBe(false);
    expect(setGate({ ...ok, scope: 'intake', target: { level: 'user', userId: M }, confirm: 'HALT intake' }).ok).toBe(false);
    expect(setGate({ ...ok, reason: 'short' }).ok).toBe(false);
    expect(setGate({ ...ok, reason: 'x'.repeat(501) }).ok).toBe(false);
    expect(setGate({ ...ok, busy: true }).ok).toBe(false);
  });
});

describe('clearing needs a different founder', () => {
  it('the proposer cannot confirm their own clear, whatever the case of the id', () => {
    expect(canConfirmClear(M, M)).toBe(false);
    expect(canConfirmClear(M.toUpperCase(), M)).toBe(false);
    expect(canConfirmClear(M, '44444444-4444-4444-8444-444444444444')).toBe(true);
    expect(canConfirmClear(M, '')).toBe(false);
  });
});

describe('what the service answered, in words', () => {
  it('only "changed" is applied; a pending clear says the halt is STILL ON', () => {
    expect(explainOutcome('changed', true).applied).toBe(true);
    expect(explainOutcome('changed', false).title).toBe('Halt cleared');
    for (const o of ['noop', 'conflict', 'pending_confirmation'] as const) expect(explainOutcome(o, false).applied).toBe(false);
    expect(explainOutcome('pending_confirmation', false).body).toContain('STILL ON');
    expect(explainOutcome('conflict', true).title).toContain('Not applied');
  });
});
