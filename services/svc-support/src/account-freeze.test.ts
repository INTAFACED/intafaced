import { describe, expect, it } from 'vitest';
import type { SupportTicket } from '@intafaced/contracts';
import type {
  SupportAccountFreezeInput,
  SupportAccountFreezeRecords,
  SupportAccountFreezeResult,
} from '@intafaced/contracts/support-account-freeze';
import { AccountFreezes, type IdentityAccountFreeze } from './account-freeze.js';

/**
 * An account freeze asked from a request (J-support-public-20 #7): svc-identity records it for the request's own
 * customer, with the agent as the signed principal; an identity with no answer, or an answer about anyone else, claims
 * nothing; a closed request takes no freeze; the read-back keeps only this request's rows.
 */

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OPERATOR = '33333333-3333-4333-8333-333333333333';
const TICKET = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AUDIT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const ticket = (over: Partial<SupportTicket> = {}): SupportTicket =>
  ({ id: TICKET, userId: CUSTOMER, category: 'deposit_withdraw', status: 'open', ...over }) as SupportTicket;

const answer = (userId: string): SupportAccountFreezeResult => ({
  recordedBy: 'svc-identity',
  userId,
  tradingRestricted: true,
  changed: true,
  auditId: AUDIT,
  recordedAt: '2026-11-24T04:00:00.000Z',
});

const row = (ticketId = TICKET) => ({
  id: AUDIT,
  ticketId,
  operatorId: OPERATOR,
  reason: 'TEST account taken over',
  restrictionSet: true,
  recordedAt: '2026-11-24T04:00:00.000Z',
});

function identity(
  reply: (input: SupportAccountFreezeInput) => SupportAccountFreezeResult | null,
  records: () => SupportAccountFreezeRecords | null = () => null,
) {
  const asked: SupportAccountFreezeInput[] = [];
  const read: Array<{ userId: string; ticketId: string }> = [];
  const port: IdentityAccountFreeze = {
    async freeze(input) {
      asked.push(input);
      return reply(input);
    },
    async records(input) {
      read.push(input);
      return records();
    },
  };
  return { asked, read, port };
}
const desk = (t: SupportTicket, port: IdentityAccountFreeze | null) => new AccountFreezes({ getTicket: async () => t }, port);
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'recorded',
    (err: { code?: string }) => err.code,
  );

describe('an account freeze asked from a request', () => {
  it("asks svc-identity for the request's own customer, as the signed agent, and answers its record", async () => {
    const { asked, port } = identity((input) => answer(input.userId));
    const got = await desk(ticket(), port).request(OPERATOR, { ticketId: TICKET, reason: 'TEST account taken over' });
    expect(got).toEqual(answer(CUSTOMER));
    expect(asked).toEqual([{ userId: CUSTOMER, ticketId: TICKET, operatorId: OPERATOR, reason: 'TEST account taken over' }]);
  });

  it('claims nothing when svc-identity gives no answer, is not wired, or answers about another account', async () => {
    for (const port of [identity(() => null).port, null, identity(() => answer(OTHER)).port])
      expect(await code(desk(ticket(), port).request(OPERATOR, { ticketId: TICKET, reason: 'TEST' }))).toBe(
        'support.account_freeze_unavailable',
      );
  });

  it('a closed request takes no freeze and svc-identity is never asked', async () => {
    const { asked, port } = identity((input) => answer(input.userId));
    expect(await code(desk(ticket({ status: 'closed' }), port).request(OPERATOR, { ticketId: TICKET, reason: 'TEST' }))).toBe(
      'support.ticket_closed',
    );
    expect(asked).toEqual([]);
  });

  it("reads back the request's rows for its own customer; a row of another request, or no answer, claims nothing", async () => {
    const good = identity(answer, () => ({ recordedBy: 'svc-identity', records: [row()] }));
    expect(await desk(ticket({ status: 'closed' }), good.port).records(OPERATOR, { ticketId: TICKET })).toEqual({
      recordedBy: 'svc-identity',
      records: [row()],
    });
    expect(good.read).toEqual([{ userId: CUSTOMER, ticketId: TICKET }]);
    const stray = identity(answer, () => ({ recordedBy: 'svc-identity', records: [row(OTHER)] }));
    expect(await code(desk(ticket(), stray.port).records(OPERATOR, { ticketId: TICKET }))).toBe('support.account_freeze_unavailable');
    expect(await code(desk(ticket(), identity(answer).port).records(OPERATOR, { ticketId: TICKET }))).toBe(
      'support.account_freeze_unavailable',
    );
  });
});
