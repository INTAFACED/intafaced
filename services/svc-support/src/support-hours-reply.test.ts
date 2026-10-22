import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import { supportCommentSchema, type Context, type SupportHours } from '@intafaced/contracts';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { MemoryOutOfHoursReplyBook, type HoursBook } from './support-hours.js';
import { OUT_OF_HOURS_AUTHOR, SupportService } from './support-service.js';

/** SP-sla-02 wiring: the out-of-hours reply once per request, and the public and lead procedures. */

const authConfig = {
  secret: 'a-support-hours-test-secret-long-enough-0123',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const LEAD = '33333333-3333-4333-8333-333333333333';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';

const always = (over: Partial<SupportHours>): SupportHours => ({
  timeZone: 'UTC',
  intervals: [],
  holidays: [],
  outOfHoursReply: 'We are closed.',
  revision: 1,
  updatedAt: null,
  ...over,
});
// Every day 00:00 to the next 00:00: open at any instant. Built by hand, not through the set schema.
const OPEN_ALL_WEEK = (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((day) => ({
  day,
  open: '00:00',
  close: '00:00',
  closesNextDay: true,
}));
const fixed = (h: SupportHours): HoursBook => ({ get: async () => h, set: async () => h });

function service(hoursBook: HoursBook, replies = new MemoryOutOfHoursReplyBook()) {
  type P = ConstructorParameters<typeof SupportService>;
  const args = new Array(16).fill(undefined) as unknown as P;
  (args as unknown[])[3] = new MemoryStaffBook();
  (args as unknown[])[14] = hoursBook;
  (args as unknown[])[15] = replies;
  return new SupportService(...args);
}

const ticket = { category: 'account', subject: 'Help', body: 'I need help' } as const;

describe('out-of-hours reply', () => {
  it('a request opened while closed gets the text once, as a desk message with a UUID author', async () => {
    const replies = new MemoryOutOfHoursReplyBook();
    // Closed: open all week, but yesterday, today and tomorrow (UTC) are holidays.
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const s = service(fixed(always({ intervals: OPEN_ALL_WEEK, holidays: [yesterday, today, tomorrow] })), replies);
    const t = await s.createTicket({ userId: CUSTOMER, ...ticket } as never);
    const comments = await s.listComments({ userId: CUSTOMER, ticketId: t.id, limit: 50 });
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorId: OUT_OF_HOURS_AUTHOR, authorRole: 'operator', body: 'We are closed.' });
    expect(supportCommentSchema.safeParse(comments[0]).success).toBe(true);
    expect(await replies.claim(t.id, new Date().toISOString())).toBe(false);
  });

  it('nothing is sent while open, with blank text, or with blank hours', async () => {
    for (const h of [
      always({ intervals: OPEN_ALL_WEEK }),
      always({ intervals: OPEN_ALL_WEEK, holidays: [new Date().toISOString().slice(0, 10)], outOfHoursReply: null }),
      always({ timeZone: null, intervals: [] }),
    ]) {
      const s = service(fixed(h));
      const t = await s.createTicket({ userId: CUSTOMER, ...ticket } as never);
      expect(await s.listComments({ userId: CUSTOMER, ticketId: t.id, limit: 50 })).toHaveLength(0);
    }
  });

  it('a failing hours book never fails the request', async () => {
    const s = service({ get: async () => Promise.reject(new Error('db down')), set: async () => Promise.reject(new Error('x')) });
    const t = await s.createTicket({ userId: CUSTOMER, ...ticket } as never);
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

async function ctx(userId: string | null, scopes: string[]): Promise<Context> {
  if (userId === null) return { principal: null, service: null, region: 'DE', requestId: 'req-hours' };
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-hours' };
}

describe('hours procedures', () => {
  async function desk() {
    const { MemoryHoursBook } = await import('./support-hours.js');
    const s = service(new MemoryHoursBook());
    const router = createSupportRouter(s, undefined, undefined, s);
    const as = async (userId: string | null, scopes = ['support:ops', 'support:read', 'support:write']) =>
      router.createCaller(await ctx(userId, scopes));
    const lead = await as(LEAD);
    await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-1' });
    return { as, lead };
  }
  const set = { holidays: [], outOfHoursReply: 'Closed', reason: 'Owner set the hours' };

  it('a visitor reads blank hours, and hoursNow refuses while blank', async () => {
    const { as } = await desk();
    const visitor = await as(null);
    expect(await visitor.hours()).toMatchObject({ timeZone: null, intervals: [], revision: 0 });
    await expect(visitor.hoursNow()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'support.hours_unset' });
  });

  it('a lead sets hours; a stale revision is CONFLICT; a non-lead is FORBIDDEN; bad input is BAD_REQUEST', async () => {
    const { as, lead } = await desk();
    const after = await lead.setHours({
      ...set,
      timeZone: 'UTC',
      intervals: [{ day: 'mon', open: '09:00', close: '17:00', closesNextDay: false }],
      expectedRevision: 0,
    });
    expect(after.revision).toBe(1);
    expect((await (await as(null)).hoursNow()).open).toEqual(expect.any(Boolean));
    await expect(lead.setHours({ ...set, timeZone: 'UTC', intervals: [], expectedRevision: 0, reason: 'other' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const customer = await as(CUSTOMER);
    await expect(customer.setHours({ ...set, timeZone: 'UTC', intervals: [], expectedRevision: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      lead.setHours({ ...set, timeZone: 'UTC', intervals: [{ day: 'mon', open: '17:00', close: '09:00' }], expectedRevision: 1 } as never),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(lead.setHours({ ...set, timeZone: 'No/Zone', intervals: [], expectedRevision: 1 })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});
