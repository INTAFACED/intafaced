import { describe, expect, it } from 'vitest';
import type { SupportRecordVerificationCheckInput, SupportTicket } from '@intafaced/contracts';
import {
  checkDigest,
  MemoryCheckBook,
  VerificationChecks,
  type VerificationAnswer,
  type VerificationOwners,
} from './verification-checks.js';
import { SupportError } from './support-service.js';

/**
 * J-support-public-20 #2 (RC-support-public-01): the customer's balance, fills or withdrawal destination is refused until
 * the request holds a matched email and a matched record id. Only the owning service's answer counts, only a digest is
 * kept, and the open gate still reads nothing.
 */

const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const TICKET = '55555555-5555-4555-8555-555555555555';
const HIDDEN = '77777777-7777-4777-8777-777777777777';
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const D1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const EMAIL = 'ann@example.com';
const AT = new Date('2026-11-02T02:00:00.000Z');

/** An owner that knows the customer's values; every question asked is kept. */
function owner(answer?: boolean | null): VerificationAnswer & { asked: unknown[] } {
  const theirs = new Set([`email:${EMAIL}`, `withdrawal_id:${W1}`, `deposit_id:${D1}`, 'client_order_id:my-order-7']);
  const asked: unknown[] = [];
  return {
    asked,
    async matches(input) {
      asked.push(input);
      if (answer !== undefined) return answer;
      return input.userId === CUSTOMER && theirs.has(`${input.kind}:${input.value}`);
    },
  };
}

function desk(owners: VerificationOwners = {}, attempts: number | null = 10) {
  const book = new MemoryCheckBook();
  const ticket = { status: 'open' as SupportTicket['status'] };
  const checks = new VerificationChecks(
    book,
    {
      getTicket: async (input) => {
        if (input.ticketId !== TICKET) throw new SupportError('ticket not found', 'support.not_found');
        return { id: TICKET, userId: CUSTOMER, status: ticket.status } as SupportTicket;
      },
    },
    attempts,
    owners,
    () => AT,
  );
  return { checks, book, ticket };
}

const all = () => {
  const o = owner();
  return { o, owners: { 'svc-identity': o, 'svc-trade': o, 'svc-pay': o } as VerificationOwners };
};
const check = (kind: SupportRecordVerificationCheckInput['kind'], value: string, ticketId = TICKET) =>
  ({ ticketId, kind, value }) as SupportRecordVerificationCheckInput;

describe('the balance disclosure gate', () => {
  it('as on main, no owner serves a door: every check refuses naming its owner, stores nothing, and every read refuses for want of checks', async () => {
    const { checks, book } = desk();
    for (const [kind, value, ownerName] of [
      ['email', EMAIL, 'svc-identity'],
      ['client_order_id', 'my-order-7', 'svc-trade'],
      ['withdrawal_id', W1, 'svc-pay'],
      ['deposit_id', D1, 'svc-pay'],
    ] as const)
      await expect(checks.record(OPERATOR, check(kind, value))).rejects.toMatchObject({
        code: 'support.disclosure_unwired',
        missingKey: ownerName,
      });
    for (const kind of ['balance', 'fills', 'destination'] as const)
      await expect(checks.disclose(OPERATOR, TICKET, kind)).rejects.toMatchObject({
        code: 'support.verification_checks_required',
        missingKey: '0 of 2 matched',
      });
    expect(book.rows).toEqual([]);
    expect(await checks.list(OPERATOR, TICKET)).toEqual({ required: 2, matched: 0, attemptsAllowed: 10, attemptsUsed: 0, checks: [] });
    // Each check and each read is an audit row with the operator; an owner with no door takes no attempt.
    expect(book.trail.filter((r) => r.action === 'record')).toHaveLength(4);
    expect(book.trail.filter((r) => r.action === 'disclosure')).toHaveLength(3);
    expect(book.trail.every((r) => r.operator === OPERATOR)).toBe(true);
  });

  it('the owner value for attempts is blank: every check refuses, never defaulted, before any owner is asked', async () => {
    const { o, owners } = all();
    const { checks, book } = desk(owners, null);
    await expect(checks.record(OPERATOR, check('email', EMAIL))).rejects.toMatchObject({ code: 'support.verification_attempts_unset' });
    expect(o.asked).toEqual([]);
    expect(book.rows).toEqual([]);
  });

  it('one matched email is not enough; the email and a record id open the gate, and the read still refuses naming its owner', async () => {
    const { o, owners } = all();
    const { checks } = desk(owners);
    const email = await checks.record(OPERATOR, check('email', ' Ann@Example.COM '));
    expect(email).toEqual({ ticketId: TICKET, kind: 'email', matched: true, checkedBy: OPERATOR, checkedAt: AT.toISOString() });
    expect(o.asked).toEqual([{ kind: 'email', value: EMAIL, userId: CUSTOMER }]);
    await expect(checks.disclose(OPERATOR, TICKET, 'balance')).rejects.toMatchObject({
      code: 'support.verification_checks_required',
      missingKey: '1 of 2 matched',
    });
    await checks.record(OPERATOR, check('withdrawal_id', W1.toUpperCase()));
    expect((await checks.list(OPERATOR, TICKET)).matched).toBe(2);
    for (const [kind, ownerName] of [
      ['balance', 'svc-ledger'],
      ['fills', 'svc-trade'],
      ['destination', 'svc-pay'],
    ] as const)
      await expect(checks.disclose(OPERATOR, TICKET, kind)).rejects.toMatchObject({
        code: 'support.disclosure_unwired',
        missingKey: ownerName,
      });
  });

  it('two record ids are not the email: the gate stays shut', async () => {
    const { owners } = all();
    const { checks } = desk(owners);
    await checks.record(OPERATOR, check('withdrawal_id', W1));
    await checks.record(OPERATOR, check('deposit_id', D1));
    await checks.record(OPERATOR, check('client_order_id', 'my-order-7'));
    await expect(checks.disclose(OPERATOR, TICKET, 'balance')).rejects.toMatchObject({ missingKey: '1 of 2 matched' });
  });

  it("another customer's id is stored unmatched, refuses without saying which part failed, and the read stays refused", async () => {
    const { owners } = all();
    const { checks, book } = desk(owners);
    await checks.record(OPERATOR, check('email', EMAIL));
    const err = await checks.record(OPERATOR, check('withdrawal_id', THEIRS)).catch((e: SupportError) => e);
    expect(err).toMatchObject({ code: 'support.verification_mismatch', missingKey: undefined });
    expect(String((err as Error).message)).not.toMatch(/withdrawal|email|owner|exist/i);
    expect((await checks.list(OPERATOR, TICKET)).checks.map((c) => [c.kind, c.matched])).toEqual([
      ['email', true],
      ['withdrawal_id', false],
    ]);
    await expect(checks.disclose(OPERATOR, TICKET, 'destination')).rejects.toMatchObject({ code: 'support.verification_checks_required' });
    // The store never holds the typed value: only a digest bound to the ticket and kind.
    expect(JSON.stringify(book.rows)).not.toContain(THEIRS);
    expect(JSON.stringify(book.rows)).not.toContain(EMAIL);
    expect(book.rows[1]!.valueDigest).toBe(checkDigest(TICKET, 'withdrawal_id', THEIRS));
    expect(checkDigest(TICKET, 'email', EMAIL)).not.toBe(checkDigest(HIDDEN, 'email', EMAIL));
  });

  it('the same value again counts once, asks nothing and takes no attempt', async () => {
    const { o, owners } = all();
    const { checks } = desk(owners, 2);
    const first = await checks.record(OPERATOR, check('email', EMAIL));
    expect(await checks.record('another-operator', check('email', 'ANN@example.com'))).toEqual(first);
    await expect(checks.record(OPERATOR, check('withdrawal_id', THEIRS))).rejects.toMatchObject({ code: 'support.verification_mismatch' });
    await expect(checks.record(OPERATOR, check('withdrawal_id', THEIRS))).rejects.toMatchObject({ code: 'support.verification_mismatch' });
    expect(o.asked).toHaveLength(2);
    expect((await checks.list(OPERATOR, TICKET)).attemptsUsed).toBe(2);
  });

  it('the attempts the owner allows run out, and then a check refuses before any owner is asked', async () => {
    const { o, owners } = all();
    const { checks } = desk(owners, 1);
    await expect(checks.record(OPERATOR, check('deposit_id', THEIRS))).rejects.toMatchObject({ code: 'support.verification_mismatch' });
    await expect(checks.record(OPERATOR, check('deposit_id', D1))).rejects.toMatchObject({
      code: 'support.verification_attempts_exhausted',
      missingKey: '1',
    });
    expect(o.asked).toHaveLength(1);
  });

  it('an owner that gives no verified answer refuses naming it, and stores nothing (no match is ever written from silence)', async () => {
    const silent = owner(null);
    const { checks, book } = desk({ 'svc-pay': silent });
    await expect(checks.record(OPERATOR, check('deposit_id', D1))).rejects.toMatchObject({
      code: 'support.disclosure_unwired',
      missingKey: 'svc-pay',
    });
    expect(book.rows).toEqual([]);
  });

  it('a closed request takes no check and opens no read, even with the gate held before it closed', async () => {
    const { owners } = all();
    const { checks, ticket } = desk(owners);
    await checks.record(OPERATOR, check('email', EMAIL));
    await checks.record(OPERATOR, check('deposit_id', D1));
    ticket.status = 'closed';
    await expect(checks.record(OPERATOR, check('withdrawal_id', W1))).rejects.toMatchObject({ code: 'support.ticket_closed' });
    await expect(checks.disclose(OPERATOR, TICKET, 'balance')).rejects.toMatchObject({ code: 'support.ticket_closed' });
  });

  it('a ticket the operator may not see answers as not found on every door, before any owner is asked', async () => {
    const { o, owners } = all();
    const { checks } = desk(owners);
    for (const call of [
      () => checks.record(OPERATOR, check('email', EMAIL, HIDDEN)),
      () => checks.list(OPERATOR, HIDDEN),
      () => checks.disclose(OPERATOR, HIDDEN, 'balance'),
    ])
      await expect(call()).rejects.toMatchObject({ code: 'support.not_found' });
    expect(o.asked).toEqual([]);
  });
});
