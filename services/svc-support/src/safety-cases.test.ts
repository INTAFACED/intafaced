import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { createSupportRouter } from './router.js';
import { MemorySafetyBook, SafetyCases, referenceOf } from './safety-cases.js';
import { SupportService } from './support-service.js';

/**
 * Complaints and bereavement reports through the router (BK-safe-03, J-bank-18 #5 #6): one acknowledgement per key with
 * the owner's deadline or "not set", a key reused with other words refused, the general form refused for both
 * categories, and each person reading only their own.
 */

const authConfig = {
  secret: 'a-support-safety-cases-test-secret-long-enough-xx',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const ANN = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const SESSION = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-11-07T08:00:00.000Z');

async function ctx(userId: string): Promise<Context> {
  const { token } = await issueAccessToken(
    { userId, sessionId: SESSION, scopes: ['support:read', 'support:write'], tier: 'none', mfa: true },
    authConfig,
  );
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-safety' };
}

function desk(days: number | null) {
  const support = new SupportService();
  const book = new MemorySafetyBook();
  const safety = new SafetyCases(book, support, days, () => NOW);
  const router = createSupportRouter(
    support,
    undefined,
    undefined,
    support,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    null,
    undefined,
    safety,
  );
  return { support, book, as: async (userId: string) => router.createCaller(await ctx(userId)) };
}

const COMPLAINT = {
  requestKey: 'complaint-key-0001',
  topic: 'payments' as const,
  details: 'TEST my transfer was held for a week with no reason given.',
  outcome: 'TEST release it and explain why',
};

const REPORT = {
  requestKey: 'bereavement-key-0001',
  deceasedName: 'Ada TEST',
  deceasedContact: 'ada@example.test',
  dateOfDeath: '2026-10-30',
  relation: 'child' as const,
  reporterName: 'Ben TEST',
  reporterContact: 'ben@example.test',
};

describe('support.safety.complain', () => {
  it('acknowledges once with the deadline from the owner limit, and makes one complaint request', async () => {
    const { support, as } = desk(15);
    const ann = await as(ANN);
    const first = await ann.safety.complain(COMPLAINT);
    expect(first.kind).toBe('complaint');
    expect(first.reference).toBe(referenceOf('complaint', first.ticketId));
    expect(first.acknowledgedAt).toBe(NOW.toISOString());
    expect(first.responseDeadline).toEqual({ status: 'set', limitDays: 15, dueAt: '2026-11-22T08:00:00.000Z' });
    const again = await ann.safety.complain(COMPLAINT);
    expect(again).toEqual(first);
    const tickets = await support.listMyTickets({ userId: ANN, limit: 50 });
    expect(tickets.filter((t) => t.category === 'complaint')).toHaveLength(1);
    expect(tickets[0]!.subject).toBe('Complaint about payments and transfers');
    expect((await ann.safety.mine()).acknowledgements).toEqual([first]);
  });

  it('with the owner limit blank, takes the complaint and its deadline reads not set', async () => {
    const { as } = desk(null);
    const ack = await (await as(ANN)).safety.complain(COMPLAINT);
    expect(ack.responseDeadline).toEqual({ status: 'not_set' });
  });

  it('refuses the same key with other words, and makes nothing new', async () => {
    const { support, as } = desk(15);
    const ann = await as(ANN);
    await ann.safety.complain(COMPLAINT);
    await expect(ann.safety.complain({ ...COMPLAINT, details: 'TEST something else entirely happened.' })).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'support.safety_key_reused' },
    });
    expect(await support.listMyTickets({ userId: ANN, limit: 50 })).toHaveLength(1);
  });

  it('mends a crash between the request and the acknowledgement: the retry writes one acknowledgement on the same request', async () => {
    const { support, book, as } = desk(15);
    const put = book.put.bind(book);
    let crash = true;
    book.put = async (row) => {
      if (crash) {
        crash = false;
        throw new Error('crash after the request was made');
      }
      return put(row);
    };
    const ann = await as(ANN);
    await expect(ann.safety.complain(COMPLAINT)).rejects.toThrow();
    const ack = await ann.safety.complain(COMPLAINT);
    const tickets = await support.listMyTickets({ userId: ANN, limit: 50 });
    expect(tickets).toHaveLength(1);
    expect(ack.ticketId).toBe(tickets[0]!.id);
    expect(book.rows).toHaveLength(1);
  });

  it('keeps each person to their own: the same key from another person is their own complaint', async () => {
    const { as } = desk(15);
    const a = await (await as(ANN)).safety.complain(COMPLAINT);
    const bob = await as(BOB);
    const b = await bob.safety.complain(COMPLAINT);
    expect(b.id).not.toBe(a.id);
    expect((await bob.safety.mine()).acknowledgements.map((x) => x.id)).toEqual([b.id]);
  });

  it('refuses a complaint or a bereavement report sent through the general request form', async () => {
    const { as } = desk(15);
    const ann = await as(ANN);
    for (const category of ['complaint', 'bereavement']) {
      await expect(ann.create({ category, subject: 'TEST', body: 'TEST body' })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'support.category_guided' },
      });
    }
  });
});

describe('support.safety.reportBereavement', () => {
  it('acknowledges once with a reference and no deadline, on one bereavement request', async () => {
    const { support, as } = desk(15);
    const ben = await as(BOB);
    const ack = await ben.safety.reportBereavement(REPORT);
    expect(ack).toMatchObject({ kind: 'bereavement', responseDeadline: null, acknowledgedAt: NOW.toISOString() });
    expect(ack.reference).toMatch(/^BR-[0-9A-F]{8}$/);
    expect(await ben.safety.reportBereavement(REPORT)).toEqual(ack);
    const tickets = await support.listMyTickets({ userId: BOB, limit: 50 });
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ category: 'bereavement', subject: 'Bereavement report' });
    expect(tickets[0]!.body).toContain('Customer who died: Ada TEST');
    expect(tickets[0]!.body).toContain('Date of death: 2026-10-30');
  });

  it('refuses a date of death in the future or not on the calendar', async () => {
    const { support, as } = desk(15);
    const ben = await as(BOB);
    for (const dateOfDeath of ['2026-11-08', '2026-02-30']) {
      await expect(
        ben.safety.reportBereavement({ ...REPORT, requestKey: `bereavement-${dateOfDeath}`, dateOfDeath }),
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        cause: { code: 'support.bereavement_date_invalid' },
      });
    }
    expect(await support.listMyTickets({ userId: BOB, limit: 50 })).toHaveLength(0);
  });
});
