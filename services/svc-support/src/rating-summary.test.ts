import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryGroupBook } from './desk-groups.js';
import { MemoryPropertiesBook } from './desk-properties.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';
import { MemoryLifecycleBook } from './ticket-lifecycle.js';

const authConfig = {
  secret: 'a-support-rating-summary-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-rating' };
}

function desk() {
  const lifecycle = new MemoryLifecycleBook();
  const support = new SupportService(
    undefined,
    undefined,
    undefined,
    new MemoryStaffBook(),
    undefined,
    null,
    undefined,
    new MemoryGroupBook(),
    [],
    new MemoryPropertiesBook(),
    lifecycle,
  );
  const router = createSupportRouter(support, undefined, undefined, support);
  const staff = async () => router.createCaller(await ctx(AGENT, ['support:ops', 'support:read', 'support:write']));
  const mine = async (userId = CUSTOMER) => router.createCaller(await ctx(userId, ['support:read', 'support:write']));
  const ticket = (userId = CUSTOMER, extra: object = {}) =>
    support.createTicket({ userId, category: 'account', subject: 'Help', body: 'Help me please', ...extra });
  return { support, staff, mine, ticket };
}

const WINDOW = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' };

describe('rating summary (SP-csat-01)', () => {
  it('shows zero responses and no share when nothing is solved or rated', async () => {
    const { staff, ticket } = desk();
    await ticket();
    expect(await (await staff()).ratingSummary(WINDOW)).toEqual({
      ...WINDOW,
      solved: 0,
      responses: 0,
      perScore: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
      ratedShareBasisPoints: null,
    });
  });

  it('counts scores and the rated share over the requests solved in the window', async () => {
    const { support, staff, mine, ticket } = desk();
    const a = await ticket();
    const b = await ticket();
    const c = await ticket();
    await ticket();
    for (const t of [a, b, c]) await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'resolved' });
    const me = await mine();
    await me.rate({ ticketId: a.id, score: 4, clientRequestId: 'r-a' });
    await me.rate({ ticketId: b.id, score: 4, note: 'Clear', clientRequestId: 'r-b' });
    expect(await (await staff()).ratingSummary(WINDOW)).toMatchObject({
      solved: 3,
      responses: 2,
      perScore: { '1': 0, '2': 0, '3': 0, '4': 2, '5': 0 },
      ratedShareBasisPoints: 6666,
    });
  });

  it('leaves out requests solved outside the window, and counts a replayed rating once', async () => {
    const { support, staff, mine, ticket } = desk();
    const t = await ticket();
    await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'resolved' });
    const me = await mine();
    await me.rate({ ticketId: t.id, score: 5, clientRequestId: 'r-1' });
    await me.rate({ ticketId: t.id, score: 5, clientRequestId: 'r-1' });
    const s = await staff();
    expect(await s.ratingSummary(WINDOW)).toMatchObject({ solved: 1, responses: 1 });
    expect(await s.ratingSummary({ from: '2000-01-01T00:00:00.000Z', to: '2001-01-01T00:00:00.000Z' })).toMatchObject({
      solved: 0,
      responses: 0,
      ratedShareBasisPoints: null,
    });
  });

  it('refuses a window that does not start before it ends, and a caller without desk scope', async () => {
    const { staff, mine } = desk();
    await expect((await staff()).ratingSummary({ from: WINDOW.to, to: WINDOW.from })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await expect((await mine()).ratingSummary(WINDOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('own rated tickets (SP-csat-01)', () => {
  it("lists only the ids of the caller's own rated tickets", async () => {
    const { support, mine, ticket } = desk();
    const a = await ticket();
    const b = await ticket();
    const other = await ticket(OTHER);
    for (const t of [a, b, other]) await support.setStatus({ operatorId: AGENT, ticketId: t.id, status: 'resolved' });
    expect(await (await mine()).ratedMine()).toEqual([]);
    await (await mine()).rate({ ticketId: a.id, score: 5, clientRequestId: 'r-a' });
    await (await mine(OTHER)).rate({ ticketId: other.id, score: 2, clientRequestId: 'r-o' });
    expect(await (await mine()).ratedMine()).toEqual([a.id]);
    expect(await (await mine(OTHER)).ratedMine()).toEqual([other.id]);
  });
});
