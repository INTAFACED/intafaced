import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPORT_AUTO_REPLY_AUTHOR_ID, type SupportHours } from '@intafaced/contracts';
import { MemoryStaffBook } from './desk-staff.js';
import { MemoryOutOfHoursReplyBook, type HoursBook, type OutOfHoursReplyBook } from './support-hours.js';
import { MemoryLifecycleBook } from './ticket-lifecycle.js';
import { OUT_OF_HOURS_AUTHOR, SupportService } from './support-service.js';

/** SP-sla-02 DR5 minors: the reserved author id, no first-response credit, and a warning when the reply fails. */

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const OPEN_ALL_WEEK = (['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((d) => ({
  day: d,
  open: '00:00',
  close: '00:00',
  closesNextDay: true,
}));
// Closed now: open all week, but yesterday, today and tomorrow (UTC) are holidays.
const CLOSED: SupportHours = {
  timeZone: 'UTC',
  intervals: OPEN_ALL_WEEK,
  holidays: [day(-1), day(0), day(1)],
  outOfHoursReply: 'We are closed.',
  revision: 1,
  updatedAt: null,
};
const fixed = (h: SupportHours): HoursBook => ({ get: async () => h, set: async () => h });
const ticket = { category: 'account', subject: 'Help', body: 'I need help' } as const;

function service(replies: OutOfHoursReplyBook, lifecycle = new MemoryLifecycleBook()) {
  type P = ConstructorParameters<typeof SupportService>;
  const args = new Array(16).fill(undefined) as unknown as P;
  (args as unknown[])[3] = new MemoryStaffBook();
  (args as unknown[])[10] = lifecycle;
  (args as unknown[])[14] = fixed(CLOSED);
  (args as unknown[])[15] = replies;
  return new SupportService(...args);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('out-of-hours auto-reply (DR5)', () => {
  it('is written as the reserved contracts author id, so screens can label it', () => {
    expect(OUT_OF_HOURS_AUTHOR).toBe(SUPPORT_AUTO_REPLY_AUTHOR_ID);
    expect(SUPPORT_AUTO_REPLY_AUTHOR_ID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('does not count as the first response for the SLA', async () => {
    const lifecycle = new MemoryLifecycleBook();
    const s = service(new MemoryOutOfHoursReplyBook(), lifecycle);
    const t = await s.createTicket({ userId: CUSTOMER, ...ticket } as never);
    const comments = await s.listComments({ userId: CUSTOMER, ticketId: t.id, limit: 50 });
    expect(comments.map((c) => c.authorId)).toEqual([SUPPORT_AUTO_REPLY_AUTHOR_ID]);
    expect((await lifecycle.get(t.id)).firstPublicReplyAt).toBeNull();
  });

  it('logs a warning, without the reply text, when the send fails; the request stands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing: OutOfHoursReplyBook = { claim: async () => Promise.reject(new Error('db down')) };
    const s = service(failing);
    const t = await s.createTicket({ userId: CUSTOMER, ...ticket } as never);
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('svc-support: out-of-hours reply not sent', { ticketId: t.id, error: 'db down' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('We are closed.');
  });
});

describe('out-of-hours auto-reply refused by the store (DR5 delta)', () => {
  it('logs a warning when addComment refuses, and the request stands', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = service(new MemoryOutOfHoursReplyBook());
    const store = (s as unknown as { store: { addComment: (i: unknown) => Promise<unknown> } }).store;
    vi.spyOn(store, 'addComment').mockResolvedValue({ status: 'refuse', reason: 'terminal' });
    const t = await s.createTicket({ userId: CUSTOMER, ...ticket } as never);
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(warn).toHaveBeenCalledWith('svc-support: out-of-hours reply not sent', { ticketId: t.id, error: 'refused: terminal' });
  });
});
