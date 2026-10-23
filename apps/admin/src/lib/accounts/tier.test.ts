import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const { tierReply } = await import('./tier');

const USER = '0b6f7a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const FOUNDER = '11111111-1111-4111-8111-111111111111';
const APPROVER = '22222222-2222-4222-8222-222222222222';
const move = {
  kind: 'identity.account.tier_move' as const,
  userId: USER,
  tierId: 'plus',
  reason: 'Customer qualifies for plus',
  version: '0',
};
const base = {
  auditId: '33333333-3333-4333-8333-333333333333',
  requestId: '44444444-4444-4444-8444-444444444444',
  userId: USER,
  tierId: 'plus',
  reason: move.reason,
  occurredAt: '2026-10-23T03:00:00.000Z',
};

describe('tierReply', () => {
  it('calls a move done only when identity changed it, naming the approver', () => {
    const reply = tierReply(move, {
      ...base,
      outcome: 'changed',
      changed: true,
      actorUserId: FOUNDER,
      approverUserId: APPROVER,
      before: { userId: USER, version: '0', tierId: null },
      after: { userId: USER, version: '1', tierId: 'plus' },
    });
    expect(reply).toEqual({ ok: true, detail: expect.stringContaining('onto tier plus at tier version 1, approved by 22222222') });
  });
  it('shows blank terms in words, with the code', () => {
    const reply = tierReply(move, {
      ...base,
      outcome: 'refused',
      changed: false,
      actorUserId: FOUNDER,
      code: 'identity.tier_terms_unset',
      current: { userId: USER, version: '0', tierId: null },
      blankTerms: ['monthlyFee', 'clearingDays'],
    });
    expect(reply).toMatchObject({ ok: false, refusal: { code: 'identity.tier_terms_unset', title: 'That tier has blank terms' } });
    expect(reply.ok === false && reply.refusal.body).toContain('Blank: monthlyFee, clearingDays.');
  });
  it('never calls an answer about another account or tier done', () => {
    const changed = {
      ...base,
      outcome: 'changed' as const,
      changed: true as const,
      actorUserId: FOUNDER,
      approverUserId: APPROVER,
      before: { userId: USER, version: '0', tierId: null },
      after: { userId: USER, version: '1', tierId: 'plus' },
    };
    expect(tierReply({ ...move, tierId: 'standard' }, changed)).toMatchObject({ ok: false, refusal: { changed: 'unknown' } });
  });
});
