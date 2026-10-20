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
  secret: 'a-support-awaiting-mine-test-secret-long-enough',
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
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-await' };
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
  );
  const router = createSupportRouter(support, undefined, undefined, support);
  const as = async (userId: string, scopes = ['support:read', 'support:write']) => router.createCaller(await ctx(userId, scopes));
  const ticket = (userId = CUSTOMER) => support.createTicket({ userId, category: 'account', subject: 'Help', body: 'Help me please' });
  return { support, as, ticket };
}

describe('support.awaitingMine (SP-help-centre-01)', () => {
  it('answers zero and no pointer when nothing waits on the customer', async () => {
    const { as, ticket } = desk();
    await ticket();
    expect(await (await as(CUSTOMER)).awaitingMine()).toEqual({ count: 0, longestWaiting: null });
  });

  it('counts the requests an operator replied to and points at the one that has waited longest', async () => {
    const { support, as, ticket } = desk();
    const a = await ticket();
    const b = await ticket();
    await support.comment({ userId: AGENT, ticketId: a.id, body: 'First', asOperator: true });
    await new Promise((r) => setTimeout(r, 5));
    await support.comment({ userId: AGENT, ticketId: b.id, body: 'Second', asOperator: true });
    const answer = await (await as(CUSTOMER)).awaitingMine();
    expect(answer.count).toBe(2);
    expect(answer.longestWaiting?.ticketId).toBe(a.id);
  });

  it('a customer reply hands the request back to the team, and a resolved request waits on nobody', async () => {
    const { support, as, ticket } = desk();
    const a = await ticket();
    const b = await ticket();
    await support.comment({ userId: AGENT, ticketId: a.id, body: 'First', asOperator: true });
    await support.comment({ userId: AGENT, ticketId: b.id, body: 'Second', asOperator: true });
    await support.comment({ userId: CUSTOMER, ticketId: a.id, body: 'Here is more' });
    await support.setStatus({ operatorId: AGENT, ticketId: b.id, status: 'resolved' });
    expect(await (await as(CUSTOMER)).awaitingMine()).toEqual({ count: 0, longestWaiting: null });
  });

  it("never counts or points at another customer's request", async () => {
    const { support, as, ticket } = desk();
    const theirs = await ticket(OTHER);
    await support.comment({ userId: AGENT, ticketId: theirs.id, body: 'Reply', asOperator: true });
    expect(await (await as(CUSTOMER)).awaitingMine()).toEqual({ count: 0, longestWaiting: null });
    expect((await (await as(OTHER)).awaitingMine()).longestWaiting?.ticketId).toBe(theirs.id);
  });

  it('needs the support:read scope', async () => {
    const { as } = desk();
    await expect((await as(CUSTOMER, ['support:write'])).awaitingMine()).rejects.toBeTruthy();
  });
});
