import { describe, expect, it } from 'vitest';
import { describeResult, historyRows, validateChange, validateLimit, validateUserId, wordsForRefusal } from './restrictions';
import { parseHistory, parseState } from './restrictions-parse';

const U = '3f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f';
const A = '00000000-0000-4000-8000-000000000001';
const base = {
  auditId: '11111111-1111-4111-8111-111111111111',
  requestId: '22222222-2222-4222-8222-222222222222',
  target: { area: 'trading', userId: U },
  action: 'restrict',
  reason: 'abuse',
  occurredAt: '2026-10-17T01:00:00.000Z',
};
const st = (version: string, restricted: boolean) => ({ target: { area: 'trading', userId: U }, version, restricted });

describe('validateUserId', () => {
  it('accepts a uuid and lower-cases it', () => expect(validateUserId(` ${U.toUpperCase()} `)).toEqual({ ok: true, value: U }));
  it('refuses empty and non-uuid with codes', () => {
    expect(validateUserId('')).toMatchObject({ ok: false, code: 'trade_ops.user_id_required' });
    expect(validateUserId('bob')).toMatchObject({ ok: false, code: 'trade_ops.user_id_invalid' });
  });
});

describe('validateLimit', () => {
  it('allows 1..200 only', () => {
    expect(validateLimit(50)).toEqual({ ok: true, value: 50 });
    expect(validateLimit('200')).toEqual({ ok: true, value: 200 });
    for (const v of [0, 201, 1.5, '-1', 'x', undefined]) expect(validateLimit(v).ok).toBe(false);
  });
});

describe('validateChange', () => {
  const ok = { userId: U, action: 'restrict', reason: 'abusive order pattern', expectedVersion: '3' };
  it('accepts a good change', () => expect(validateChange(ok)).toEqual({ ok: true, value: ok }));
  it('refuses bad action, short or long reason, bad version', () => {
    expect(validateChange({ ...ok, action: 'freeze' })).toMatchObject({ code: 'trade_ops.action_invalid' });
    expect(validateChange({ ...ok, reason: 'ab' })).toMatchObject({ code: 'trade_ops.reason_invalid' });
    expect(validateChange({ ...ok, reason: 'x'.repeat(501) })).toMatchObject({ code: 'trade_ops.reason_invalid' });
    expect(validateChange({ ...ok, expectedVersion: '03' })).toMatchObject({ code: 'trade_ops.version_invalid' });
    expect(validateChange({ ...ok, expectedVersion: 3 })).toMatchObject({ code: 'trade_ops.version_invalid' });
  });
});

describe('parseState', () => {
  it('reads a state, null for no account, undefined for a wrong shape', () => {
    expect(parseState(st('2', true))).toMatchObject({ version: '2', restricted: true });
    expect(parseState(null)).toBeNull();
    expect(parseState({ version: 2 })).toBeUndefined();
  });
});

describe('history', () => {
  const changed = { ...base, outcome: 'changed', changed: true, actorUserId: A, before: st('0', false), after: st('1', true) };
  const conflict = {
    ...base,
    outcome: 'conflict',
    changed: false,
    actorUserId: A,
    code: 'restriction.version_conflict',
    current: st('4', true),
  };
  const refused = { ...base, outcome: 'refused', changed: false, actorUserId: null, code: 'mfa.required', current: null };
  it('parses the three outcomes and rejects an incoherent row', () => {
    expect(parseHistory([changed, conflict, refused])).toHaveLength(3);
    expect(parseHistory([{ ...changed, after: st('5', true) }])).toBeNull();
    expect(parseHistory('x')).toBeNull();
  });
  it('says each outcome in words', () => {
    const rows = parseHistory([changed, conflict, refused]) ?? [];
    expect(describeResult(rows[0]!)).toContain('version 0 to 1');
    expect(describeResult(rows[1]!)).toContain('Someone changed this account since you looked');
    expect(describeResult(rows[2]!)).toContain('second sign-in factor');
  });
  it('flattens rows with versions and codes', () => {
    const [c, k, r] = historyRows(parseHistory([changed, conflict, refused]) ?? []);
    expect([c!.versionBefore, c!.versionAfter, c!.code]).toEqual(['0', '1', null]);
    expect([k!.versionBefore, k!.code]).toEqual(['4', 'restriction.version_conflict']);
    expect([r!.actor, r!.versionBefore]).toEqual([null, null]);
  });
  it('words every contract refusal code', () => {
    for (const c of [
      'operator.denied',
      'mfa.required',
      'authority.unavailable',
      'edge.authority_unavailable',
      'target.not_found',
      'restore.not_permitted',
      'request.conflict',
      'restriction.version_conflict',
    ])
      expect(wordsForRefusal(c)).not.toContain('The service refused with');
  });
});
