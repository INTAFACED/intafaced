import { describe, expect, it } from 'vitest';
import { issueAccessToken, verifyAccessToken } from '@intafaced/auth';
import type { Context } from '@intafaced/contracts';
import { MemoryStaffBook } from './desk-staff.js';
import { createSupportRouter } from './router.js';
import { SupportService } from './support-service.js';

/** J-support-public-10 #8: a staff reply after someone else changed the request is refused as stale and writes nothing. */

const authConfig = {
  secret: 'a-support-comment-stale-test-secret-long-enough-x',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const LEAD = '33333333-3333-4333-8333-333333333333';
const AGENT = '44444444-4444-4444-8444-444444444444';
const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SESSION = '66666666-6666-4666-8666-666666666666';

async function ctx(userId: string, scopes: string[]): Promise<Context> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'none', mfa: true }, authConfig);
  return { principal: await verifyAccessToken(token, authConfig), service: null, region: 'DE', requestId: 'req-stale' };
}

async function desk() {
  const support = new SupportService(undefined, undefined, undefined, new MemoryStaffBook());
  const router = createSupportRouter(support, undefined, undefined, support);
  const as = async (userId: string, scopes = ['support:ops', 'support:read', 'support:write']) =>
    router.createCaller(await ctx(userId, scopes));
  const lead = await as(LEAD);
  await lead.staffAppoint({ userId: LEAD, role: 'lead', idempotencyKey: 'appoint-lead-stale' });
  await lead.staffAppoint({ userId: AGENT, role: 'agent', idempotencyKey: 'appoint-agent-stale' });
  const ticket = await support.createTicket({ userId: CUSTOMER, category: 'account', subject: 'Stale', body: 'Help me please' });
  return { lead, agent: await as(AGENT), ticket };
}

const lastSequence = (rows: { sequence: number }[]) => Math.max(0, ...rows.map((r) => r.sequence));

describe('stale staff reply (J-support-public-10 #8)', () => {
  it('refuses a reply after another agent moved the request, writes nothing, and takes it once the agent has read the change', async () => {
    const { lead, agent, ticket } = await desk();
    await lead.claim({ ticketId: ticket.id });
    const seen = lastSequence(await lead.events({ ticketId: ticket.id, limit: 50 }));
    await agent.setStatus({ ticketId: ticket.id, status: 'on_hold', note: 'Waiting on a partner' });
    await expect(lead.comment({ ticketId: ticket.id, body: 'Here is your answer', seenEventSequence: seen })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'support.comment_stale',
    });
    expect(await lead.listComments({ ticketId: ticket.id, limit: 50 })).toHaveLength(0);
    const read = lastSequence(await lead.events({ ticketId: ticket.id, limit: 50 }));
    await lead.comment({ ticketId: ticket.id, body: 'Here is your answer', seenEventSequence: read });
    expect(await lead.listComments({ ticketId: ticket.id, limit: 50 })).toHaveLength(1);
  });

  it("the agent's own changes since are not someone else's: a second reply goes through", async () => {
    const { lead, ticket } = await desk();
    const seen = lastSequence(await lead.events({ ticketId: ticket.id, limit: 50 }));
    await lead.claim({ ticketId: ticket.id });
    await lead.comment({ ticketId: ticket.id, body: 'First answer', seenEventSequence: seen });
    await lead.comment({ ticketId: ticket.id, body: 'Second answer', seenEventSequence: seen });
    expect(await lead.listComments({ ticketId: ticket.id, limit: 50 })).toHaveLength(2);
  });

  it('a staff reply that names no seen row is not checked', async () => {
    const { lead, agent, ticket } = await desk();
    await agent.setStatus({ ticketId: ticket.id, status: 'pending' });
    await lead.comment({ ticketId: ticket.id, body: 'Looking now' });
    expect(await lead.listComments({ ticketId: ticket.id, limit: 50 })).toHaveLength(1);
  });
});
