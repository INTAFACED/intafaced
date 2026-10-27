import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryGroupBook } from './desk-groups.js';
import { MemoryPropertiesBook } from './desk-properties.js';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';
import { MemoryLifecycleBook } from './ticket-lifecycle.js';
import { TEST_COMMENT_CAP } from './comment-cap.fixture.js';

const authConfig = {
  secret: 'a-support-customer-status-test-secret-long-enough',
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
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-customer-status' };
}

function desk() {
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
    new MemoryLifecycleBook(),
    undefined,
    undefined,
    null,
    undefined,
    TEST_COMMENT_CAP,
  );
  const router = createSupportRouter(support, undefined, undefined, support);
  const as = async (userId: string, scopes = ['support:read', 'support:write']) => router.createCaller(await ctx(userId, scopes));
  const ticket = (userId = CUSTOMER, clientRequestId?: string) =>
    support.createTicket({
      userId,
      category: 'account',
      subject: 'Help',
      body: 'Help me please',
      ...(clientRequestId ? { clientRequestId } : {}),
    });
  return { support, as, ticket };
}

describe("the customer status on the owner's reads (SP-tickets-01)", () => {
  it('reads Open, then Awaiting your reply after a team reply, then Open after the customer answers, then Solved', async () => {
    const { support, as, ticket } = desk();
    const a = await ticket();
    const me = await as(CUSTOMER);
    const status = async () => [(await me.listMine({ limit: 10 }))[0]!.customerStatus, (await me.get({ ticketId: a.id })).customerStatus];
    expect(await status()).toEqual(['open', 'open']);
    await support.comment({ userId: AGENT, ticketId: a.id, body: 'Which device?', asOperator: true });
    expect(await status()).toEqual(['awaiting_reply', 'awaiting_reply']);
    await support.comment({ userId: CUSTOMER, ticketId: a.id, body: 'My phone' });
    expect(await status()).toEqual(['open', 'open']);
    await support.setStatus({ operatorId: AGENT, ticketId: a.id, status: 'resolved' });
    expect(await status()).toEqual(['solved', 'solved']);
  });

  it("a staff read of someone else's request carries no customer status", async () => {
    const { support, ticket } = desk();
    const a = await ticket();
    expect((await support.getTicket({ userId: AGENT, ticketId: a.id, asOperator: true })).customerStatus).toBeUndefined();
  });
});

describe('support.createdByRequest (SP-tickets-01 recovery)', () => {
  it('reads the request a create key made, as it stands now, and makes nothing', async () => {
    const { support, as, ticket } = desk();
    const made = await ticket(CUSTOMER, 'create:lost-answer');
    await support.comment({ userId: AGENT, ticketId: made.id, body: 'Hello', asOperator: true });
    const me = await as(CUSTOMER);
    const read = await me.createdByRequest({ clientRequestId: 'create:lost-answer' });
    expect(read?.id).toBe(made.id);
    expect(read?.customerStatus).toBe('awaiting_reply');
    expect(await me.listMine({ limit: 10 })).toHaveLength(1);
  });

  it("answers null for a key that made nothing, and for another account's key", async () => {
    const { as, ticket } = desk();
    await ticket(OTHER, 'create:theirs');
    const me = await as(CUSTOMER);
    expect(await me.createdByRequest({ clientRequestId: 'create:never-sent' })).toBeNull();
    expect(await me.createdByRequest({ clientRequestId: 'create:theirs' })).toBeNull();
  });

  it('needs support:read', async () => {
    const { as } = desk();
    await expect((await as(CUSTOMER, [])).createdByRequest({ clientRequestId: 'create:x' })).rejects.toThrow();
  });
});
