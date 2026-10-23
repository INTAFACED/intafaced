import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { restoreReply } = await import('./restore');

const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const request = { kind: 'identity.account.unfreeze' as const, userId: USER, reason: 'Customer verified by phone', version: '1' };
const base = {
  auditId: '33333333-3333-4333-8333-333333333333',
  requestId: '44444444-4444-4444-8444-444444444444',
  target: { area: 'identity' as const, userId: USER },
  action: 'restore' as const,
  reason: request.reason,
  occurredAt: '2026-10-23T01:00:00.000Z',
};
const state = (restricted: boolean, version: string) => ({ target: base.target, version, restricted });

describe('what identity answered to a restore', () => {
  it('counts a lifted freeze as done and names the approver', () => {
    const reply = restoreReply(request, {
      ...base,
      outcome: 'changed',
      changed: true,
      actorUserId: FOUNDER,
      approverUserId: APPROVER,
      before: state(true, '1'),
      after: state(false, '2'),
    });
    expect(reply).toEqual({ ok: true, detail: expect.stringContaining('approved by 22222222') });
  });
  it('shows identity’s refusal in words, with its code', () => {
    const reply = restoreReply(request, {
      ...base,
      outcome: 'refused',
      changed: false,
      actorUserId: FOUNDER,
      code: 'restriction_no_four_eyes',
      current: state(true, '1'),
    });
    expect(reply).toMatchObject({
      ok: false,
      refusal: { code: 'restriction_no_four_eyes', title: 'Lifting this freeze needs a second person' },
    });
  });
  it('never calls an answer about another account done', () => {
    const other = { area: 'identity' as const, userId: '55555555-5555-4555-8555-555555555555' };
    const reply = restoreReply(request, {
      ...base,
      target: other,
      outcome: 'changed',
      changed: true,
      actorUserId: FOUNDER,
      before: { target: other, version: '1', restricted: true },
      after: { target: other, version: '2', restricted: false },
    });
    expect(reply.ok).toBe(false);
  });
});
