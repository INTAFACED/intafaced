import { describe, expect, it } from 'vitest';
import { decisionGate, decisionPhrase, payloadRows, timeLeft, type CustodyTask } from './model';

const ME = 'founder-me';
const OTHER = 'founder-other';
const NOW = new Date('2026-10-20T12:00:00Z');
const task = (over: Partial<CustodyTask> = {}): CustodyTask => ({
  id: '11111111-1111-4111-8111-111111111111',
  clientRef: 'r',
  kind: 'config',
  scope: 'policy',
  title: 'Publish policy',
  payload: { rule: 'two approvers', limits: { daily: 5 } },
  payloadHash: 'abcdef0123456789'.repeat(4),
  initiator: OTHER,
  requiredApprovals: 2,
  approvalCount: 0,
  approvedByMe: false,
  status: 'pending',
  failureCode: null,
  expiresAt: '2026-10-20T18:00:00Z',
  createdAt: '2026-10-20T10:00:00Z',
  decidedAt: null,
  executedAt: null,
  ...over,
});

describe('the phrase an approver types', () => {
  it('carries the first eight characters of the fingerprint they read', () => {
    expect(decisionPhrase('approve', task())).toBe('APPROVE abcdef01');
    expect(decisionPhrase('reject', task())).toBe('REJECT abcdef01');
    expect(decisionPhrase('cancel', task())).toBe('CANCEL');
  });
});

describe('who may decide, as the console shows it', () => {
  it('lets another approver approve or reject a waiting task', () => {
    expect(decisionGate('approve', task(), ME, NOW)).toEqual({ ok: true });
    expect(decisionGate('reject', task(), ME, NOW)).toEqual({ ok: true });
  });
  it('never lets the initiator approve or reject, and lets only them cancel', () => {
    expect(decisionGate('approve', task({ initiator: ME }), ME, NOW)).toMatchObject({ ok: false });
    expect(decisionGate('reject', task({ initiator: ME }), ME, NOW)).toMatchObject({ ok: false });
    expect(decisionGate('cancel', task({ initiator: ME }), ME, NOW)).toEqual({ ok: true });
    expect(decisionGate('cancel', task(), ME, NOW)).toMatchObject({ ok: false });
  });
  it('refuses a second approval from the same person, but still lets them reject', () => {
    expect(decisionGate('approve', task({ approvedByMe: true }), ME, NOW)).toMatchObject({ ok: false });
    expect(decisionGate('reject', task({ approvedByMe: true }), ME, NOW)).toEqual({ ok: true });
  });
  it('refuses everything once the task is decided, expired or past its deadline', () => {
    for (const status of ['approved', 'rejected', 'canceled', 'expired', 'failed', 'executed'] as const)
      expect(decisionGate('approve', task({ status }), ME, NOW)).toMatchObject({ ok: false });
    expect(decisionGate('approve', task({ expiresAt: '2026-10-20T11:00:00Z' }), ME, NOW)).toMatchObject({ ok: false });
  });
});

describe('reading a task', () => {
  it('lists every payload field and writes nested values as JSON, rounding nothing', () => {
    expect(payloadRows(task().payload)).toEqual([
      ['rule', 'two approvers'],
      ['limits', '{"daily":5}'],
    ]);
  });
  it('says how long is left, and nothing once the deadline passed', () => {
    expect(timeLeft('2026-10-20T12:00:30Z', NOW)).toBe('under a minute left');
    expect(timeLeft('2026-10-20T12:45:00Z', NOW)).toBe('45 min left');
    expect(timeLeft('2026-10-20T18:00:00Z', NOW)).toBe('6 h left');
    expect(timeLeft('2026-10-24T12:00:00Z', NOW)).toBe('4 days left');
    expect(timeLeft('2026-10-20T11:59:59Z', NOW)).toBeNull();
  });
});
