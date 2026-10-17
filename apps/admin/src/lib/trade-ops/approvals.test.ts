import { describe, expect, it } from 'vitest';
import {
  appendLog,
  knownRequester,
  loadLog,
  parseLog,
  sameOperator,
  saveLog,
  serviceCode,
  validateAct,
  validateApply,
  wordsForApprovalCode,
  type ApprovalLogEntry,
} from './approvals';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const H = `sha256:${'a'.repeat(64)}`;

describe('serviceCode', () => {
  it('pulls the bracketed code from a tRPC message', () => {
    expect(serviceCode('http.412', 'the requester cannot approve their own action [action_approval.same_person]')).toBe(
      'action_approval.same_person',
    );
  });
  it('keeps a code that is already specific, and a generic one with nothing to pull', () => {
    expect(serviceCode('action_approval.expired', 'x')).toBe('action_approval.expired');
    expect(serviceCode('http.500', 'boom')).toBe('http.500');
  });
});

describe('validateAct', () => {
  it('refuses approve or reject when the known requester is the signed-in user', () => {
    for (const verb of ['approve', 'reject'])
      expect(validateAct({ verb, approvalId: 'a1', expectedPayloadHash: H, knownRequesterId: ME.toUpperCase() }, ME)).toMatchObject({
        ok: false,
        code: 'action_approval.same_person',
      });
  });
  it('lets the requester revoke their own request', () => {
    expect(validateAct({ verb: 'revoke', approvalId: 'a1', knownRequesterId: ME }, ME)).toMatchObject({ ok: true });
  });
  it('lets a different person approve with a well-formed hash', () => {
    expect(validateAct({ verb: 'approve', approvalId: ' a1 ', expectedPayloadHash: H, knownRequesterId: OTHER }, ME)).toEqual({
      ok: true,
      value: { verb: 'approve', approvalId: 'a1', expectedPayloadHash: H, knownRequesterId: OTHER },
    });
  });
  it('needs a hash to approve, an id for everything, and a known verb', () => {
    expect(validateAct({ verb: 'approve', approvalId: 'a1', expectedPayloadHash: 'abc' }, ME)).toMatchObject({
      code: 'trade_ops.payload_hash_invalid',
    });
    expect(validateAct({ verb: 'reject', approvalId: '  ' }, ME)).toMatchObject({ code: 'trade_ops.approval_id_invalid' });
    expect(validateAct({ verb: 'nuke', approvalId: 'a' }, ME)).toMatchObject({ code: 'trade_ops.verb_invalid' });
  });
});

describe('validateApply', () => {
  it('needs an approval id and a uuid request id', () => {
    expect(validateApply({ approvalId: 'a', requestId: ME })).toMatchObject({ ok: true });
    expect(validateApply({ approvalId: 'a', requestId: 'x' })).toMatchObject({ code: 'trade_ops.request_id_invalid' });
    expect(validateApply({ approvalId: '', requestId: ME })).toMatchObject({ code: 'trade_ops.approval_id_invalid' });
  });
});

describe('words and identity', () => {
  it('has words for the service refusals the brief names', () => {
    for (const c of [
      'action_approval.same_person',
      'action_approval.payload_mismatch',
      'action_approval.expired',
      'action_approval.not_pending',
      'action_approval.not_found',
    ])
      expect(wordsForApprovalCode(c)).toBeTruthy();
    expect(wordsForApprovalCode('weird')).toBeNull();
  });
  it('compares operators ignoring case and blanks', () => {
    expect(sameOperator(ME, ME.toUpperCase())).toBe(true);
    expect(sameOperator(ME, OTHER)).toBe(false);
    expect(sameOperator(null, null)).toBe(false);
  });
});

describe('session log', () => {
  const e = (over: Partial<ApprovalLogEntry> = {}): ApprovalLogEntry => ({
    at: 't',
    actorUserId: ME,
    verb: 'propose',
    approvalId: 'a1',
    actionType: 'x',
    targetId: 'y',
    requesterId: ME,
    reason: 'r',
    outcome: 'ok',
    result: 'PENDING',
    ...over,
  });
  it('keeps newest first and caps length', () => {
    let l: ApprovalLogEntry[] = [];
    for (let i = 0; i < 205; i += 1) l = appendLog(l, e({ at: String(i) }));
    expect(l).toHaveLength(200);
    expect(l[0]!.at).toBe('204');
  });
  it('round-trips through storage and ignores garbage', () => {
    const mem = new Map<string, string>();
    const s = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    saveLog(s, [e()]);
    expect(loadLog(s)).toHaveLength(1);
    expect(parseLog('{nope')).toEqual([]);
    expect(parseLog('[1,{"at":"t"}]')).toEqual([]);
  });
  it('finds who proposed an approval this tab has seen', () => {
    expect(knownRequester([e()], 'a1')).toBe(ME);
    expect(knownRequester([e()], 'zzz')).toBeUndefined();
  });
});
