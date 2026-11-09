import { describe, expect, it } from 'vitest';
import type { SupportTicket, SupportWithdrawalFreezeInput, SupportWithdrawalFreezeResult } from '@intafaced/contracts';
import { WithdrawalFreezes, type IdentityWithdrawalFreeze } from './withdrawal-freeze.js';

/**
 * A withdrawal freeze asked from a request (J-support-public-20 #7): svc-identity records it for the request's own
 * customer, with the agent as the signed principal; an identity with no answer, or an answer about anyone else, claims
 * nothing; a closed request takes no freeze.
 */

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const TICKET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const ticket = (over: Partial<SupportTicket> = {}): SupportTicket =>
  ({ id: TICKET, userId: CUSTOMER, category: 'deposit_withdraw', status: 'open', ...over }) as SupportTicket;

const answer = (userId: string, locked = true): SupportWithdrawalFreezeResult => ({
  recordedBy: 'svc-identity',
  lock: { userId, locked, lockedAt: '2026-11-09T03:00:00.000Z', setBy: 'support', unlockRequestedAt: null, unlocksAt: null },
  changed: true,
  auditId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  recordedAt: '2026-11-09T03:00:00.000Z',
});

function identity(reply: (input: SupportWithdrawalFreezeInput) => SupportWithdrawalFreezeResult | null) {
  const asked: SupportWithdrawalFreezeInput[] = [];
  const port: IdentityWithdrawalFreeze = {
    async freeze(input) {
      asked.push(input);
      return reply(input);
    },
  };
  return { asked, port };
}
const desk = (t: SupportTicket, port: IdentityWithdrawalFreeze | null) => new WithdrawalFreezes({ getTicket: async () => t }, port);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'recorded',
    (err: { code?: string }) => err.code,
  );

describe('a withdrawal freeze asked from a request', () => {
  it("asks svc-identity for the request's own customer, as the signed agent, and answers its record", async () => {
    const { asked, port } = identity((input) => answer(input.userId));
    const got = await desk(ticket(), port).request(OPERATOR, { ticketId: TICKET, reason: 'TEST withdrawal missing' });
    expect(got).toMatchObject({ recordedBy: 'svc-identity', lock: { userId: CUSTOMER, locked: true } });
    expect(asked).toEqual([{ userId: CUSTOMER, ticketId: TICKET, operatorId: OPERATOR, reason: 'TEST withdrawal missing' }]);
  });

  it('claims nothing when svc-identity gives no answer, is not wired, or answers about another account or an unlocked one', async () => {
    for (const port of [identity(() => null).port, null, identity(() => answer(OTHER)).port, identity(() => answer(CUSTOMER, false)).port])
      expect(await code(desk(ticket(), port).request(OPERATOR, { ticketId: TICKET, reason: 'TEST' }))).toBe(
        'support.withdrawal_freeze_unavailable',
      );
  });

  it('a closed request takes no freeze, and svc-identity is never asked', async () => {
    const { asked, port } = identity((input) => answer(input.userId));
    expect(await code(desk(ticket({ status: 'closed' }), port).request(OPERATOR, { ticketId: TICKET, reason: 'TEST' }))).toBe(
      'support.ticket_closed',
    );
    expect(asked).toEqual([]);
  });
});
