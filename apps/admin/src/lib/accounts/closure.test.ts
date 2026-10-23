import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { closureReply } = await import('./closure');

const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const close = {
  kind: 'identity.account.close' as const,
  userId: USER,
  reasonCode: 'customer_request' as const,
  reason: 'Customer asked by letter',
  version: '1',
};
const base = {
  auditId: '33333333-3333-4333-8333-333333333333',
  requestId: '44444444-4444-4444-8444-444444444444',
  userId: USER,
  action: 'close' as const,
  reasonCode: 'customer_request' as const,
  reason: close.reason,
  occurredAt: '2026-10-23T01:00:00.000Z',
};
const state = (status: 'active' | 'closed', version: string) => ({
  userId: USER,
  version,
  status,
  closedBy: status === 'closed' ? ('customer' as const) : null,
  closeReasonCode: status === 'closed' ? ('customer_request' as const) : null,
  reopenable: status === 'closed',
});

describe('what identity answered to a staff close or reopen', () => {
  it('counts a closed account as done and names the approver', () => {
    const reply = closureReply(close, {
      ...base,
      outcome: 'changed',
      changed: true,
      actorUserId: FOUNDER,
      approverUserId: APPROVER,
      before: state('active', '1'),
      after: state('closed', '2'),
    });
    expect(reply).toEqual({ ok: true, detail: expect.stringContaining('closed') });
    expect(reply).toEqual({ ok: true, detail: expect.stringContaining('approved by 22222222') });
  });
  it('shows a blocked close in words, with its code', () => {
    const reply = closureReply(close, {
      ...base,
      outcome: 'refused',
      changed: false,
      actorUserId: FOUNDER,
      code: 'identity.close_blocked',
      current: state('active', '1'),
      blockers: [{ code: 'bank.balance_open', count: 1 }],
    });
    expect(reply).toMatchObject({
      ok: false,
      refusal: { code: 'identity.close_blocked', title: 'The account still has open products or balances' },
    });
    expect(reply.ok === false && reply.refusal.body).toContain('Still open: 1 × bank.balance_open.');
    const named = closureReply(close, {
      ...base,
      outcome: 'refused',
      changed: false,
      actorUserId: FOUNDER,
      code: 'identity.close_blocked',
      current: state('active', '1'),
      blockers: [
        { code: 'active_card', count: 2 },
        { code: 'open_order', count: 1 },
      ],
    });
    expect(named.ok === false && named.refusal.body).toContain('Still open: 2 × card not closed, 1 × open order.');
  });
  it('never calls an answer about another account or another action done', () => {
    const changed = {
      ...base,
      outcome: 'changed' as const,
      changed: true as const,
      actorUserId: FOUNDER,
      approverUserId: APPROVER,
      before: state('active', '1'),
      after: state('closed', '2'),
    };
    expect(closureReply({ ...close, userId: '55555555-5555-4555-8555-555555555555' }, changed)).toMatchObject({ ok: false });
    expect(closureReply({ kind: 'identity.account.reopen', userId: USER, reason: close.reason, version: '1' }, changed)).toMatchObject({
      ok: false,
    });
  });
});
