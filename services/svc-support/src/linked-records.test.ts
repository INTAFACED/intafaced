import { describe, expect, it } from 'vitest';
import { SUPPORT_RECORD_OWNERSHIP_PATH, verifyServiceRequest, type SupportTicket } from '@intafaced/contracts';
import {
  createRecordOwnershipClient,
  LinkedRecords,
  MemoryLinkBook,
  UNWIRED_RECORD_OWNERSHIP,
  type RecordOwnershipDoor,
} from './linked-records.js';
import { keyCases, recorder, SECRET } from './s2s-keys-fixture.js';
import { SupportError } from './support-service.js';

/**
 * J-support-public-20 #1: only a record that already belongs to the ticket's customer can be linked to it. The customer comes
 * off the ticket; svc-pay says whether a withdrawal or deposit is theirs; anything but a verified "yes" links nothing.
 */

const OPERATOR = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const OTHER = '66666666-6666-4666-8666-666666666666';
const TICKET = '55555555-5555-4555-8555-555555555555';
const HIDDEN = '77777777-7777-4777-8777-777777777777';
const MINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const THEIRS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING = '00000000-0000-4000-8000-000000000000';
const AT = new Date('2026-11-02T01:00:00.000Z');

/** svc-pay as a table of (kind, id) → owner; every question asked is kept. */
function pay(records: Record<string, string>, answer?: boolean | null): RecordOwnershipDoor & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    configured: true,
    asked,
    async owns(input) {
      asked.push(input);
      if (answer !== undefined) return answer;
      return records[`${input.kind}:${input.recordId}`] === input.userId;
    },
  };
}

function desk(door: RecordOwnershipDoor = pay({ [`withdrawal:${MINE}`]: CUSTOMER, [`deposit:${THEIRS}`]: OTHER })) {
  const book = new MemoryLinkBook();
  const reads: unknown[] = [];
  const links = new LinkedRecords(
    book,
    {
      getTicket: async (input) => {
        reads.push(input);
        if (input.ticketId !== TICKET) throw new SupportError('ticket not found', 'support.not_found');
        return { id: TICKET, userId: CUSTOMER } as SupportTicket;
      },
    },
    door,
    () => AT,
  );
  return { book, links, reads };
}

describe('linking a record to a request', () => {
  it("links a withdrawal svc-pay says is the ticket customer's, once, with who and when", async () => {
    const door = pay({ [`withdrawal:${MINE}`]: CUSTOMER });
    const { links } = desk(door);
    const link = await links.link(OPERATOR, { ticketId: TICKET, kind: 'withdrawal', recordId: MINE });
    expect(link).toEqual({ ticketId: TICKET, kind: 'withdrawal', recordId: MINE, linkedBy: OPERATOR, linkedAt: AT.toISOString() });
    // The customer svc-pay was asked about is the ticket's, never the operator.
    expect(door.asked).toEqual([{ kind: 'withdrawal', recordId: MINE, userId: CUSTOMER }]);
    // Linking it again returns the first link and asks nothing more.
    expect(await links.link('other-operator', { ticketId: TICKET, kind: 'withdrawal', recordId: MINE.toUpperCase() })).toEqual(link);
    expect(door.asked).toHaveLength(1);
    expect(await links.list(OPERATOR, TICKET)).toEqual([link]);
  });

  it("another customer's record and one that does not exist refuse alike, and nothing is linked", async () => {
    const { links } = desk();
    for (const [kind, recordId] of [
      ['deposit', THEIRS],
      ['withdrawal', MISSING],
      // A withdrawal id asked as a deposit is not this customer's deposit.
      ['deposit', MINE],
    ] as const) {
      await expect(links.link(OPERATOR, { ticketId: TICKET, kind, recordId })).rejects.toMatchObject({
        code: 'support.link_record_not_owned',
        missingKey: undefined,
      });
    }
    expect(await links.list(OPERATOR, TICKET)).toEqual([]);
  });

  it('a svc-pay that gives no verified answer refuses naming it, never as not owned and never as owned', async () => {
    const { links } = desk(pay({}, null));
    await expect(links.link(OPERATOR, { ticketId: TICKET, kind: 'withdrawal', recordId: MINE })).rejects.toMatchObject({
      code: 'support.link_record_owner_unreachable',
      missingKey: 'svc-pay',
    });
    const unwired = desk(UNWIRED_RECORD_OWNERSHIP);
    await expect(unwired.links.link(OPERATOR, { ticketId: TICKET, kind: 'deposit', recordId: MINE })).rejects.toMatchObject({
      code: 'support.link_record_owner_unwired',
      missingKey: 'svc-pay',
    });
    expect(await links.list(OPERATOR, TICKET)).toEqual([]);
    expect(await unwired.links.list(OPERATOR, TICKET)).toEqual([]);
  });

  it('an order refuses naming svc-trade, which has no ownership answer, and svc-pay is not asked', async () => {
    const door = pay({}, true);
    const { links } = desk(door);
    await expect(links.link(OPERATOR, { ticketId: TICKET, kind: 'order', recordId: MINE })).rejects.toMatchObject({
      code: 'support.link_record_owner_unwired',
      missingKey: 'svc-trade',
    });
    expect(door.asked).toEqual([]);
    expect(await links.list(OPERATOR, TICKET)).toEqual([]);
  });

  it('a ticket the operator may not see answers as not found, before any owner is asked', async () => {
    const door = pay({}, true);
    const { links, reads } = desk(door);
    await expect(links.link(OPERATOR, { ticketId: HIDDEN, kind: 'withdrawal', recordId: MINE })).rejects.toMatchObject({
      code: 'support.not_found',
    });
    await expect(links.list(OPERATOR, HIDDEN)).rejects.toMatchObject({ code: 'support.not_found' });
    expect(door.asked).toEqual([]);
    expect(reads).toEqual([
      { userId: OPERATOR, ticketId: HIDDEN, asOperator: true },
      { userId: OPERATOR, ticketId: HIDDEN, asOperator: true },
    ]);
  });
});

describe("svc-pay's record ownership door, as the desk calls it", () => {
  const ask = { kind: 'withdrawal' as const, recordId: MINE, userId: CUSTOMER };
  const answering = (status: number, body: string) =>
    (async () => new Response(body, { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('is unconfigured with no address or no credential', () => {
    expect(createRecordOwnershipClient({ secret: SECRET }).configured).toBe(false);
    expect(createRecordOwnershipClient({ payUrl: 'http://pay:4005', secret: '' }).configured).toBe(false);
    expect(createRecordOwnershipClient({ payUrl: 'http://user:pw@pay:4005', secret: SECRET }).configured).toBe(false);
    expect(createRecordOwnershipClient({ payUrl: 'http://pay:4005', secret: SECRET }).configured).toBe(true);
  });

  it('sends one signed POST to the door, the body bound to the signature as svc-pay requires', async () => {
    const { fetchImpl, sent } = recorder();
    await createRecordOwnershipClient({ payUrl: 'http://pay:4005/', secret: SECRET, fetcher: fetchImpl }).owns(ask);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.url.href).toBe(`http://pay:4005${SUPPORT_RECORD_OWNERSHIP_PATH}`);
    expect(JSON.parse(sent[0]!.body)).toEqual(ask);
    const s = sent[0]!;
    const verdict = verifyServiceRequest(
      { method: s.method, url: s.url.pathname, headers: s.headers, body: s.body },
      { legacySecret: SECRET, bodyBindMode: 'require' },
    );
    expect(verdict.service).toBe('svc-support');
    // The same signature over another body is refused.
    const moved = verifyServiceRequest(
      { method: s.method, url: s.url.pathname, headers: s.headers, body: JSON.stringify({ ...ask, userId: OTHER }) },
      { legacySecret: SECRET, bodyBindMode: 'require' },
    );
    expect(moved.service).toBeNull();
  });

  it('only a 200 with exactly the contract answer counts; everything else is no answer', async () => {
    const client = (fetcher: typeof fetch) => createRecordOwnershipClient({ payUrl: 'http://pay:4005', secret: SECRET, fetcher });
    expect(await client(answering(200, '{"owned":true}')).owns(ask)).toBe(true);
    expect(await client(answering(200, '{"owned":false}')).owns(ask)).toBe(false);
    // svc-pay without the door: a 404 is not "no such record".
    expect(await client(answering(404, '{"message":"Route POST:/internal/support/record-ownership not found"}')).owns(ask)).toBeNull();
    expect(await client(answering(401, '{"error":"pay.unauthenticated"}')).owns(ask)).toBeNull();
    expect(await client(answering(500, 'oops')).owns(ask)).toBeNull();
    expect(await client(answering(200, '{"owned":"yes"}')).owns(ask)).toBeNull();
    expect(await client(answering(200, '{"owned":true,"amount":"10"}')).owns(ask)).toBeNull();
    expect(await client(answering(200, 'not json')).owns(ask)).toBeNull();
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await client(down).owns(ask)).toBeNull();
  });

  it('a svc-pay that never answers is no answer once the time bound passes', async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
    const client = createRecordOwnershipClient({ payUrl: 'http://pay:4005', secret: SECRET, fetcher: hang, timeoutMs: 20 });
    expect(await client.owns(ask)).toBeNull();
  });

  keyCases('the ownership ask', 'svc-pay', async (fetchImpl, s2s) => {
    await createRecordOwnershipClient({ payUrl: 'http://pay:4005', secret: SECRET, s2s, fetcher: fetchImpl }).owns(ask);
  });
});
